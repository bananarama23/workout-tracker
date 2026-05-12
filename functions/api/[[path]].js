import worker from "../../ai-proxy/cloudflare-worker.js";

export async function onRequest(context) {
  return worker.fetch(context.request, context.env, context);
}
