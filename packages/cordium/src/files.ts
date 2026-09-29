import { open, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, basename, join, posix } from "node:path";
import type { Workspace } from "./workspace.js";
import { shellQuote, type ExecOptions, type ExecSession } from "./exec.js";
import { CordiumError, integer, nonempty } from "./errors.js";

/** Transfer settings. File helpers own stdin and capture configuration. */
export type FileOptions = Pick<
  ExecOptions,
  "signal" | "timeoutMs" | "root" | "cwd"
>;
/** In-memory reads are bounded to 64 MiB by default. */
export interface ReadFileOptions extends FileOptions {
  /** Maximum bytes to read; exceeding this throws rather than returning a partial file. */
  maxBytes?: number;
}

/** File transfers through exec. Remote images need POSIX sh, head, base64, mkdir, and cat. */
export class Files {
  /** @internal */
  constructor(private readonly workspace: Workspace) {}
  /** Write text as UTF-8 or binary bytes, create parents, and replace the destination. */
  async write(
    path: string,
    data: string | Uint8Array,
    options?: FileOptions,
  ): Promise<void> {
    const bytes =
      typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    await this.uploadBytes(
      path,
      bytes.length,
      (async function* () {
        yield bytes;
      })(),
      options,
    );
  }
  /** Read a bounded binary file. Throws RESOURCE_EXHAUSTED if it exceeds maxBytes. */
  async read(path: string, options: ReadFileOptions = {}): Promise<Uint8Array> {
    nonempty(path, "Remote path");
    const max = integer(
      options.maxBytes ?? 64 * 1024 * 1024,
      "maxBytes",
      0,
      0xfffffffe,
    );
    const result = await this.workspace.exec(
      `head -c ${max + 1} < ${shellQuote(path)}`,
      {
        ...options,
        timeoutMs: options.timeoutMs ?? 30_000,
        maxCaptureBytes: max + 1,
        check: true,
      },
    );
    if (result.stdoutBytes.length > max || result.truncated)
      throw new CordiumError("File exceeds maxBytes", "RESOURCE_EXHAUSTED");
    return result.stdoutBytes;
  }
  /** Read a UTF-8 text file using the same size limit as read(). */
  async readText(path: string, options?: ReadFileOptions): Promise<string> {
    return new TextDecoder().decode(await this.read(path, options));
  }
  /** Stream a local file to the workspace. The local file must not change during upload. */
  async upload(
    localPath: string,
    remotePath: string,
    options?: FileOptions,
  ): Promise<void> {
    const file = await open(localPath, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new CordiumError(
          "Upload source must be a regular file",
          "INVALID_ARGUMENT",
        );
      await this.uploadBytes(
        remotePath,
        stat.size,
        file.createReadStream({ autoClose: false }),
        options,
      );
    } finally {
      await file.close();
    }
  }
  /** Stream a download to a temporary local file, replacing localPath only after successful completion. */
  async download(
    remotePath: string,
    localPath: string,
    options: FileOptions = {},
  ): Promise<void> {
    nonempty(remotePath, "Remote path");
    nonempty(localPath, "Local path");
    const directory = await mkdtemp(
      join(dirname(localPath), `.${basename(localPath)}-`),
    );
    const temporary = join(directory, "download");
    try {
      const file = await open(temporary, "wx", 0o600);
      let session: ExecSession | undefined;
      try {
        session = this.workspace.execStream(`cat < ${shellQuote(remotePath)}`, {
          ...options,
          timeoutMs: options.timeoutMs ?? 30_000,
          interactive: false,
          maxCaptureBytes: 64 * 1024,
          check: true,
        });
        for await (const chunk of session)
          if (chunk.stream === "stdout") {
            let offset = 0;
            while (offset < chunk.data.length) {
              const result = await file.write(
                chunk.data,
                offset,
                chunk.data.length - offset,
              );
              if (!result.bytesWritten)
                throw new CordiumError(
                  "Local file write made no progress",
                  "DATA_LOSS",
                );
              offset += result.bytesWritten;
            }
          }
        await session.wait();
      } finally {
        session?.close();
        await file.close();
      }
      await rename(temporary, localPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async uploadBytes(
    path: string,
    size: number,
    source: AsyncIterable<Uint8Array>,
    options: FileOptions = {},
  ): Promise<void> {
    nonempty(path, "Remote path");
    integer(size, "File size", 0, Number.MAX_SAFE_INTEGER / 4);
    const encodedSize = Math.ceil(size / 3) * 4;
    const parent = posix.dirname(path);
    const command = `mkdir -p -- ${shellQuote(parent)} && head -c ${encodedSize} | base64 -d > ${shellQuote(path)}`;
    const session = this.workspace.execStream(command, {
      ...options,
      timeoutMs: options.timeoutMs ?? 30_000,
      interactive: true,
      maxCaptureBytes: 64 * 1024,
      check: true,
    });
    const result = session.wait();
    void result.catch(() => {});
    try {
      let count = 0,
        remainder = Buffer.alloc(0);
      for await (const chunk of source) {
        count += chunk.length;
        if (count > size)
          throw new CordiumError("Upload source changed size", "DATA_LOSS");
        const data = Buffer.concat([remainder, chunk]);
        const length = data.length - (data.length % 3);
        if (length)
          await session.write(data.subarray(0, length).toString("base64"));
        remainder = Buffer.from(data.subarray(length));
      }
      if (count !== size)
        throw new CordiumError(
          "Upload source ended before the declared size",
          "DATA_LOSS",
        );
      if (remainder.length) await session.write(remainder.toString("base64"));
      await result;
    } finally {
      session.close();
    }
  }
}
