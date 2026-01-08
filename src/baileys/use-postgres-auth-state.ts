import type { Pool } from "pg";
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "baileys";
import { initAuthCreds, proto } from "baileys";
import { BufferJSON } from "./buffer-json";

type KeyCategory = keyof SignalDataTypeMap;

type AuthStateResult = {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
};

export const usePostgresAuthState = async (pool: Pool, sessionId: string): Promise<AuthStateResult> => {
  const encode = (obj: unknown) => JSON.parse(JSON.stringify(obj, BufferJSON.replacer));
  const decode = (obj: unknown) => JSON.parse(JSON.stringify(obj), BufferJSON.reviver);

  const readCreds = async (): Promise<AuthenticationCreds> => {
    const { rows } = await pool.query('SELECT "creds" FROM "WaAuthCreds" WHERE "sessionId" = $1', [sessionId]);
    if (!rows.length) return initAuthCreds() as unknown as AuthenticationCreds;
    return decode(rows[0].creds) as AuthenticationCreds;
  };

  const writeCreds = async (creds: AuthenticationCreds) => {
    await pool.query(
      'INSERT INTO "WaAuthCreds" ("sessionId", "creds", "updatedAt") VALUES ($1, $2, NOW()) ' +
        'ON CONFLICT ("sessionId") DO UPDATE SET "creds" = EXCLUDED."creds", "updatedAt" = NOW()',
      [sessionId, encode(creds)],
    );
  };

  const readKey = async (category: string, keyId: string) => {
    const { rows } = await pool.query(
      'SELECT "value" FROM "WaAuthKey" WHERE "sessionId" = $1 AND "category" = $2 AND "keyId" = $3',
      [sessionId, category, keyId],
    );
    if (!rows.length) return null;
    return rows[0].value ? decode(rows[0].value) : null;
  };

  const writeKey = async (category: string, keyId: string, value: unknown) => {
    if (value == null) {
      await pool.query('DELETE FROM "WaAuthKey" WHERE "sessionId" = $1 AND "category" = $2 AND "keyId" = $3', [
        sessionId,
        category,
        keyId,
      ]);
      return;
    }

    await pool.query(
      'INSERT INTO "WaAuthKey" ("sessionId", "category", "keyId", "value", "updatedAt") VALUES ($1, $2, $3, $4, NOW()) ' +
        'ON CONFLICT ("sessionId", "category", "keyId") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = NOW()',
      [sessionId, category, keyId, encode(value)],
    );
  };

  const creds = await readCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends KeyCategory>(type: T, ids: string[]) => {
          const out: { [_: string]: SignalDataTypeMap[T] } = {} as { [_: string]: SignalDataTypeMap[T] };

          await Promise.all(
            ids.map(async (id) => {
              let value = await readKey(type as string, id);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.create(value as proto.Message.IAppStateSyncKeyData);
              }
              out[id] = value;
            }),
          );

          return out;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];

          for (const category of Object.keys(data) as KeyCategory[]) {
            const catData = data[category];
            if (catData) {
              for (const id of Object.keys(catData)) {
                const value = (catData as Record<string, unknown>)[id];
                tasks.push(writeKey(category as string, id, value));
              }
            }
          }

          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeCreds(creds);
    },
  };
};
