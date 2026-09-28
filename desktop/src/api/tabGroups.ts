import type {
  TabGroupArchiveList,
  TabGroupArchive,
  TabGroupCommandResponse,
  TabGroupDeleteResponse,
  TabGroupRestoreTarget,
} from "../types"
import { backendRequest } from "./client"

export async function listTabGroupArchives(): Promise<TabGroupArchiveList> {
  return backendRequest<TabGroupArchiveList>("GET", "/tab-groups")
}

export async function restoreTabGroupArchive(
  archiveId: string,
  target: TabGroupRestoreTarget,
): Promise<TabGroupCommandResponse> {
  return backendRequest<TabGroupCommandResponse>(
    "POST",
    `/tab-groups/${encodeURIComponent(archiveId)}/restore`,
    { target },
  )
}

export async function deleteTabGroupArchive(archiveId: string): Promise<TabGroupDeleteResponse> {
  return backendRequest<TabGroupDeleteResponse>("DELETE", `/tab-groups/${encodeURIComponent(archiveId)}`)
}
