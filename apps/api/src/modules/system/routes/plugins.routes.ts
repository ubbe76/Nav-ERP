import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createPluginSchema,
  PLUGIN_MANIFEST_MAX_BYTES,
  pluginContextSchema,
  pluginPreviewSchema,
  updatePluginSchema,
} from "@navet/shared";
import { errorBody } from "../service/error-body.js";
import type { PluginsService } from "../service/plugins.service.js";
import { buildPluginKitCss } from "../service/plugin-kit-css.js";
import type { ThemesService } from "../service/themes.service.js";
import {
  PluginAccessDeniedError,
  PluginDeliveryNotFoundError,
  PluginDeliveryNotRetryableError,
  PluginInvalidAddressError,
  PluginKeyTakenError,
  PluginManifestInvalidError,
  PluginManifestUnreachableError,
  PluginNotFoundError,
  PluginSameOriginError,
} from "../service/plugins.errors.js";

// A manifest is at most 64 kB; slack for the JSON wrapping around it.
const PLUGIN_BODY_LIMIT = PLUGIN_MANIFEST_MAX_BYTES + 8192;

function mapPluginError(reply: FastifyReply, err: unknown) {
  if (err instanceof PluginManifestInvalidError) {
    return reply.code(400).send({ ...errorBody(err), errors: err.errors, warnings: err.warnings });
  }
  if (err instanceof PluginInvalidAddressError || err instanceof PluginSameOriginError) return reply.code(400).send(errorBody(err));
  if (err instanceof PluginAccessDeniedError) return reply.code(403).send(errorBody(err));
  if (err instanceof PluginNotFoundError || err instanceof PluginDeliveryNotFoundError) return reply.code(404).send(errorBody(err));
  if (err instanceof PluginKeyTakenError || err instanceof PluginDeliveryNotRetryableError) return reply.code(409).send(errorBody(err));
  if (err instanceof PluginManifestUnreachableError) return reply.code(502).send(errorBody(err));
  throw err;
}

// GET /plugin-kit.css — public: an embedded plugin page links it (from the
// plugin's own origin, without Nav's cookie). The themes' token CSS is
// already public through /theme-boot.
export async function pluginKitRoutes(app: FastifyInstance, opts: { themes: ThemesService }) {
  app.get("/plugin-kit.css", async (_req, reply) => {
    const { css } = await opts.themes.boot();
    reply.header("Content-Type", "text/css; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=300");
    // Plugins load it cross-origin.
    reply.header("Access-Control-Allow-Origin", "*");
    return reply.send(buildPluginKitCss(css));
  });
}

// System → Tillägg. Registered with the admin-only module rule in app.ts;
// GET /plugin-ui and POST /plugins/:id/context are open to every office
// user (the service checks the page's/tab's own permission). A plugin's
// own API key is refused on all of /plugins (requireAuth).
export async function pluginRoutes(app: FastifyInstance, opts: { service: PluginsService }) {
  const { service } = opts;

  app.get("/plugins", async () => service.list());

  // Fetches or checks a manifest; saves nothing.
  app.post("/plugins/preview", { bodyLimit: PLUGIN_BODY_LIMIT, config: { readOnlySafe: true } }, async (req, reply) => {
    try {
      return await service.preview(pluginPreviewSchema.parse(req.body));
    } catch (err) {
      return mapPluginError(reply, err);
    }
  });

  app.post("/plugins", { bodyLimit: PLUGIN_BODY_LIMIT }, async (req, reply) => {
    const input = createPluginSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.install(input, req.user!.id));
    } catch (err) {
      return mapPluginError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/plugins/:id", async (req, reply) => {
    try {
      return await service.get(req.params.id);
    } catch (err) {
      return mapPluginError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>("/plugins/:id", { bodyLimit: PLUGIN_BODY_LIMIT }, async (req, reply) => {
    const input = updatePluginSchema.parse(req.body);
    try {
      return await service.update(req.params.id, input, req.user!.id);
    } catch (err) {
      return mapPluginError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/plugins/:id", async (req, reply) => {
    try {
      await service.uninstall(req.params.id, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return mapPluginError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/plugins/:id/rotate-key", async (req, reply) => {
    try {
      return await service.rotateKey(req.params.id, req.user!.id);
    } catch (err) {
      return mapPluginError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/plugins/:id/rotate-secret", async (req, reply) => {
    try {
      return await service.rotateSecret(req.params.id, req.user!.id);
    } catch (err) {
      return mapPluginError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/plugins/:id/test-event", async (req, reply) => {
    try {
      return await service.testEvent(req.params.id);
    } catch (err) {
      return mapPluginError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/plugins/:id/deliveries", async (req, reply) => {
    try {
      return await service.deliveries(req.params.id);
    } catch (err) {
      return mapPluginError(reply, err);
    }
  });

  app.post<{ Params: { id: string; deliveryId: string } }>("/plugins/:id/deliveries/:deliveryId/retry", async (req, reply) => {
    try {
      return await service.retryDelivery(req.params.id, req.params.deliveryId);
    } catch (err) {
      return mapPluginError(reply, err);
    }
  });

  // The web's hubs and cards: what this user may see.
  app.get("/plugin-ui", { config: { access: ["office"] } }, async (req) => service.ui(req.user!));

  // A page/tab opening: computes and signs, writes nothing — so an Endast
  // läsning account may open plugin pages too.
  app.post<{ Params: { id: string } }>(
    "/plugins/:id/context",
    { config: { access: ["office"], readOnlySafe: true } },
    async (req, reply) => {
      const input = pluginContextSchema.parse(req.body ?? {});
      try {
        return await service.context(req.params.id, input, req.user!);
      } catch (err) {
        return mapPluginError(reply, err);
      }
    }
  );
}
