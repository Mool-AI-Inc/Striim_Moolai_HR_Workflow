/**
 * In-memory Drive fake — Layer-B scaffolding the UC3 workflow test injects.
 * @lifespan THROWAWAY — lives under src/ but is never imported by a prod entrypoint; a test double only.
 * @responsibility Mimic DriveConnector.putFile: record every call's folder/name/bytes/contentType and return
 *   a deterministic fileId. ONLY putFile — no setPermissions, matching the real connector's shape.
 */
import type { DriveConnector } from "../../../platform/connectors/types.js";

export interface RecordedFile { folderId: string; name: string; bytes: Uint8Array; contentType: string; }

export class InMemoryDrive implements DriveConnector {
  readonly files: RecordedFile[] = [];
  private seq = 0;

  async putFile(folderId: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ fileId: string }> {
    this.files.push({ folderId, name, bytes, contentType });
    return { fileId: `file-${++this.seq}` };
  }
}
