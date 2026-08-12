from pathlib import Path

from PyInstaller.utils.hooks import collect_all, copy_metadata


BACKEND_DIR = Path(SPEC).resolve().parent

datas = []
binaries = []
hiddenimports = []

for package in ("lancedb", "manga_ocr"):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

for package in (
    "lancedb",
    "manga-ocr",
    "transformers",
    "tokenizers",
    "safetensors",
    "huggingface-hub",
):
    datas += copy_metadata(package)

hiddenimports += [
    "onnxruntime",
    "pyarrow",
    "torch",
    "transformers",
]

a = Analysis(
    [str(BACKEND_DIR / "main.py")],
    pathex=[str(BACKEND_DIR)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "IPython",
        "jupyter",
        "matplotlib",
        "pytest",
        "ragas",
        "tensorflow",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="tabkeep-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
