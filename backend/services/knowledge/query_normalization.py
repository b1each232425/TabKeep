from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable


FtsTermLookup = Callable[[list[str]], dict[str, list[tuple[str, int]]]]

_ZERO_WIDTH_RE = re.compile(r"[\u200b-\u200f\u2060\ufeff]")
_WHITESPACE_RE = re.compile(r"\s+")
_TECHNICAL_TERM_RE = re.compile(r"(?<![A-Za-z0-9_])[A-Za-z]{5,}(?![A-Za-z0-9_])")
_TERM_RE = re.compile(r"[a-z]{5,}")
_PUNCTUATION_TRANSLATION = str.maketrans(
    {
        "‘": "'",
        "’": "'",
        "‛": "'",
        "“": '"',
        "”": '"',
        "„": '"',
        "–": "-",
        "—": "-",
        "−": "-",
    }
)


def normalize_query(query: str, term_lookup: FtsTermLookup | None = None) -> str:
    """Normalize query text and conservatively fix known English technical terms."""
    normalized = unicodedata.normalize("NFKC", query or "")
    normalized = _ZERO_WIDTH_RE.sub("", normalized)
    normalized = normalized.translate(_PUNCTUATION_TRANSLATION)
    normalized = _WHITESPACE_RE.sub(" ", normalized).strip()
    if not normalized or term_lookup is None:
        return normalized

    query_terms = list(
        dict.fromkeys(
            match.group(0).casefold()
            for match in _TECHNICAL_TERM_RE.finditer(normalized)
            if not match.group(0).isupper()
        )
    )
    candidates_by_term = term_lookup(query_terms) if query_terms else {}

    def correct_term(match: re.Match[str]) -> str:
        term = match.group(0)
        if term.isupper():
            return term

        lookup_term = term.casefold()
        correction = _select_correction(lookup_term, candidates_by_term.get(lookup_term, []))
        return correction or term

    return _TECHNICAL_TERM_RE.sub(correct_term, normalized)


def _select_correction(term: str, candidates: list[tuple[str, int]]) -> str | None:
    if not _TERM_RE.fullmatch(term):
        return None

    exact_term_exists = False
    matches: list[tuple[str, int]] = []
    for candidate, document_frequency in candidates:
        normalized_candidate = candidate.casefold()
        if normalized_candidate == term:
            exact_term_exists = True
            continue
        if (
            document_frequency >= 2
            and _TERM_RE.fullmatch(normalized_candidate)
            and normalized_candidate[0] == term[0]
            and not (term.endswith("s") and normalized_candidate == term[:-1])
            and _one_edit_apart(term, normalized_candidate)
        ):
            matches.append((normalized_candidate, document_frequency))

    if exact_term_exists or not matches:
        return None

    matches.sort(key=lambda item: (-item[1], item[0]))
    if len(matches) > 1 and matches[0][1] < matches[1][1] * 3:
        return None
    return matches[0][0]


def _one_edit_apart(left: str, right: str) -> bool:
    if left == right or abs(len(left) - len(right)) > 1:
        return False

    if len(left) == len(right):
        mismatches = [
            index
            for index, (left_char, right_char) in enumerate(zip(left, right, strict=True))
            if left_char != right_char
        ]
        if len(mismatches) == 1:
            return True
        if len(mismatches) == 2:
            first, second = mismatches
            return (
                second == first + 1
                and left[first] == right[second]
                and left[second] == right[first]
            )
        return False

    shorter, longer = (left, right) if len(left) < len(right) else (right, left)
    short_index = 0
    long_index = 0
    skipped = False
    while short_index < len(shorter) and long_index < len(longer):
        if shorter[short_index] == longer[long_index]:
            short_index += 1
            long_index += 1
            continue
        if skipped:
            return False
        skipped = True
        long_index += 1
    return True
