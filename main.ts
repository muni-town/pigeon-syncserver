import {
  Peer,
  RuntimeDriverUniversal,
  ServerExtension,
} from "@earthstar/earthstar";
import { AutoRouter, AutoRouterType, error } from "itty-router";
import {
  Server,
  ExtensionSyncWebsocket,
  getStorageDriverFilesystem,
} from "@earthstar/earthstar/deno";
import { decodeBase64 } from "jsr:@std/encoding@0.224/base64";

class InviteHandler implements ServerExtension {
  router: AutoRouterType;
  peer?: Peer;

  constructor() {
    this.router = AutoRouter();

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

const server = new Server(
  [new ExtensionSyncWebsocket("sync"), new InviteHandler()],
  {
    peer: new Peer({
      password: "server",
      runtime: new RuntimeDriverUniversal(),
      storage: await getStorageDriverFilesystem("./data"),
    }),
    port: parseInt(Deno.env.get("PORT") || "8000"),
  }
);

Deno.addSignalListener("SIGINT", () => {
  console.log("KEYBOARD INTERRUPT: stopping server.");
  server.close();
  Deno.exit();
});
