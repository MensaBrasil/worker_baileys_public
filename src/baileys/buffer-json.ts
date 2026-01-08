export const BufferJSON = {
  replacer: (_: string, value: unknown) => {
    if (
      Buffer.isBuffer(value) ||
      value instanceof Uint8Array ||
      (value && typeof value === "object" && (value as { type?: string }).type === "Buffer")
    ) {
      const data = (value as { data?: ArrayLike<number> }).data;
      return {
        type: "Buffer",
        data: Buffer.from(data ?? (value as Uint8Array)).toString("base64"),
      };
    }

    return value;
  },
  reviver: (_: string, value: unknown) => {
    if (value && typeof value === "object") {
      const typed = value as { buffer?: boolean; type?: string; data?: unknown; value?: unknown };
      if (typed.buffer === true || typed.type === "Buffer") {
        const val = typed.data ?? typed.value;
        if (typeof val === "string") {
          return Buffer.from(val, "base64");
        }
        return Buffer.from((val as ArrayLike<number>) ?? []);
      }
    }

    return value;
  },
};
