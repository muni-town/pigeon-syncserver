// deno-lint-ignore-file no-explicit-any
import {
  EarthstarError,
  IdentityTag,
  isErr,
  Peer,
  RuntimeDriverUniversal,
  ServerExtension,
  Syncer,
} from "@muni-town-temp/earthstar";
import { AutoRouter, AutoRouterType, error, cors } from "itty-router";
import {
  RuntimeDriverDeno,
  Server,
  getStorageDriverFilesystem,
} from "@muni-town-temp/earthstar/deno";
import { decodeBase64 } from "jsr:@std/encoding@0.224/base64";
import { delay } from "@std/async";
import { IS_BETTY, TransportWebsocket } from "@earthstar/willow";
import { encodeShareTag } from "https://jsr.io/@muni-town-temp/earthstar/11.0.0-beta.7.patched.1/src/identifiers/share.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
export function encodeText(text: string): Uint8Array {
  return textEncoder.encode(text);
}
export function decodeText(binary: Uint8Array): string {
  return textDecoder.decode(binary);
}
export function encodeJson(data: any): Uint8Array {
  return encodeText(JSON.stringify(data));
}
export function decodeJson<T>(binary: Uint8Array): T {
  return JSON.parse(decodeText(binary));
}

async function getId(peer: Peer): Promise<IdentityTag | undefined> {
  let id;
  for await (const x of peer.identities()) {
    id = x;
    break;
  }
  return id?.tag;
}

class InviteHandler implements ServerExtension {
  router: AutoRouterType;
  peer?: Peer;
  syncers: Syncer[] = [];

  pruneSyncers() {
    this.syncers = this.syncers.filter((x) => !x.isClosed);
  }

  addSyncer(syncer: Syncer) {
    this.pruneSyncers();
    this.syncers.push(syncer);
  }

  forceReconcile() {
    this.syncers.forEach((x) => x.forceReconcile());
  }

  constructor() {
    const { preflight, corsify } = cors();
    this.router = AutoRouter({
      before: [preflight],
      finally: [corsify],
    });

    this.router.get("/sync", async (req) => {
      const peer = this.peer;
      if (!peer) return error(500, "Missing peer");

      const { socket, response } = Deno.upgradeWebSocket(req);

      const transport = new TransportWebsocket(IS_BETTY, socket);

      const syncer = new Syncer({
        auth: peer.auth,
        maxPayloadSizePower: 8,
        transport,
        interests: await peer.auth.interestsFromCaps(),
        getStore: async (share) => {
          const tag = encodeShareTag(share);

          const result = await peer.getStore(tag);

          if (isErr(result)) {
            throw new EarthstarError(
              "Could not get Store requested by Syncer."
            );
          }

          return result;
        },
        runtime: new RuntimeDriverDeno(),
      });
      this.addSyncer(syncer);

      return response;
    });

    this.router.get("/id", async () => {
      if (!this.peer) return error(500, "Peer not started.");
      const id = await getId(this.peer);
      if (!id) return error(500, "Server has no ID?");
      return { publicKey: id };
    });

    this.router.get("/addRoom/:readCap/:writeCap", async ({ params }) => {
      if (!this.peer) return error(500);
      const { readCap, writeCap } = params;
      const readCapImp = decodeBase64(decodeURIComponent(readCap));
      const writeCapImp = decodeBase64(decodeURIComponent(writeCap));
      await this.peer.importCap(readCapImp);
      await this.peer.importCap(writeCapImp);
      return { success: true };
    });
  }

  handler(req: Request): Promise<Response | null> {
    return this.router.fetch(req);
  }
  register(peer: Peer): Promise<void> {
    this.peer = peer;
    return Promise.resolve();
  }
}

const peer = new Peer({
  password: "server",
  runtime: new RuntimeDriverUniversal(),
  storage: await getStorageDriverFilesystem("./data"),
});

let id = await getId(peer);
if (!id) {
  const result = await peer.createIdentity("srvr");
  if (isErr(result)) throw "Could not create keypair";
  id = result.tag;
}
console.log("Server ID", id);

const handler = new InviteHandler();

// TODO: this is a temporary solution until we get a more proper sync implemented
// in earthstar.

let exit = false;
(async () => {
  if (exit) return;
  handler.forceReconcile();
  await delay(1000);
})();

const server = new Server([handler], {
  peer,
  port: parseInt(Deno.env.get("PORT") || "8000"),
});

(async () => {
  while (true) {
    const data: { [key: string]: any } = {};
    const shares = await peer.shares();
    console.info("shares", shares);
    for (const share of shares) {
      const store = await peer.getStore(share);
      if (isErr(store)) throw store;
      const storeDump: { [key: string]: any } = {};
      for await (const doc of store.documents({ order: "timestamp" })) {
        const key = doc.path.asStrings()!.join("/");
        storeDump[key] = decodeJson(await doc.payload!.bytes());
      }
      data[share] = storeDump;
    }

    console.info(data);

    await delay(8000);
  }
})();

Deno.addSignalListener("SIGINT", () => {
  console.log("KEYBOARD INTERRUPT: stopping server.");
  exit = true;
  server.close();
  Deno.exit();
});
