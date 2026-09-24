/**
 * pi-reload-self-hardened — fork local de npm:pi-reload-self (0.1.1), 2026-09-24.
 *
 * Pourquoi le fork : la version npm patche `ExtensionRunner.prototype.createContext`
 * pour exposer `reload()` au context tool. Sur pi 0.87.1, le runner construit le
 * context tool par PROJECTION À LISTE BLANCHE (20 clés, pas de `reload`) — le
 * patch s'applique mais est immédiatement filtré : le tool retombe en mode
 * « commande manuelle » à chaque fois.
 *
 * Mécanisme (API publique uniquement, aucun monkey-patching) :
 *   tool → storePendingReloadCommand (globalThis, dedup)
 *        → événement `agent_settled` (exécution « fully settled »)
 *        → pi.sendUserMessage("/pi-reload-self-hardened-run <token>",
 *              { deliverAs: "followUp", expandPromptTemplates: true })
 *        → prompt() dispatche la commande extension
 *        → handler : guard isIdle + storeContinuationPrompt + await ctx.reload()
 *        → session_start(reason: "reload") → sendUserMessage(continuation, followUp)
 *        → nouveau turn, zéro intervention manuelle.
 *
 * Architecture alignée sur le PR #1 de clankercode/pi-reload-self (limitsurface,
 * « Use public settled dispatch ») : événement agent_settled au lieu d'un timer
 * de polling, guard d'idle DANS la commande (corrige la course « commande
 * consommée sans reload »), dedup de la commande en attente. Ajouts locaux :
 * logging fichier (le PR est silencieux) et `Promise.resolve` sur
 * `sendUserMessage` (le binding d'extension retourne `undefined`, wrapper
 * interne sans return — un `.catch` direct crashait pi, payé le 2026-09-24).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync } from "node:fs";

const COMMAND_NAME = "pi-reload-self-hardened-run";
const TOOL_NAME = "pi_extension_dev_reload_self";
const CONTINUATION_SLOT = "__piReloadSelfHardenedContinuationPrompt";
const PENDING_COMMAND_SLOT = "__piReloadSelfHardenedPendingCommand";
const LOG_FILE = "/tmp/pi-reload-self-hardened.log";

function log(msg: string): void {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // diagnostic optionnel
  }
}

interface ReloadPayload {
  continuationPrompt: string;
}

function validateContinuationPrompt(value: unknown): string {
  if (typeof value !== "string") throw new Error("continuation_prompt must be a non-empty string");
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("continuation_prompt must be a non-empty string");
  return trimmed;
}

function encodeReloadPayload(payload: ReloadPayload): string {
  return Buffer.from(JSON.stringify({ continuationPrompt: validateContinuationPrompt(payload.continuationPrompt) }), "utf8").toString("base64url");
}

function decodeReloadPayload(encoded: string): ReloadPayload {
  const token = encoded.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid payload token");
  const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid payload");
  const { continuationPrompt } = parsed as ReloadPayload;
  validateContinuationPrompt(continuationPrompt);
  return { continuationPrompt: (continuationPrompt as string).trim() };
}

function globalState(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

function storeContinuationPrompt(prompt: string): void {
  globalState()[CONTINUATION_SLOT] = prompt;
}

function takeContinuationPrompt(): string | undefined {
  const state = globalState();
  const prompt = state[CONTINUATION_SLOT] as string | undefined;
  delete state[CONTINUATION_SLOT];
  return prompt;
}

function storePendingReloadCommand(command: string): boolean {
  const state = globalState();
  if (typeof state[PENDING_COMMAND_SLOT] === "string") return false; // déjà en file
  state[PENDING_COMMAND_SLOT] = command;
  return true;
}

function takePendingReloadCommand(): string | undefined {
  const state = globalState();
  const command = state[PENDING_COMMAND_SLOT] as string | undefined;
  delete state[PENDING_COMMAND_SLOT];
  return command;
}

function clearPendingReloadCommand(): void {
  delete globalState()[PENDING_COMMAND_SLOT];
}

export default async function reloadSelfHardenedExtension(pi: ExtensionAPI): Promise<void> {
  // Après un reload, le prompt de continuation (stocké dans globalThis, qui
  // survit à la mort du runtime) repart en message user follow-up.
  pi.on("session_start", (event) => {
    // Une commande en attente appartient au run qui l'a créée : si la session
    // est remplacée avant son settlement, on ne la porte pas vers l'avant.
    clearPendingReloadCommand();

    const continuationPrompt = takeContinuationPrompt();
    if (continuationPrompt) {
      log(`session_start(${String((event as { reason?: string }).reason)}): continuation envoyée (${continuationPrompt.length} chars)`);
      // Le binding d'extension peut retourner undefined (wrapper interne sans
      // return) : Promise.resolve évite un crash et reste compatible avec un
      // futur pi qui retournerait une vraie promise.
      void Promise.resolve(pi.sendUserMessage(continuationPrompt, { deliverAs: "followUp" })).catch((e: unknown) =>
        log(`continuation: envoi échoué — ${String(e instanceof Error ? e.message : e)}`),
      );
    }
  });

  // Le dispatch volontairement ici et nulle part ailleurs : Pi expand/dispatch
  // les slash commands AVANT de mettre les messages en file, donc envoyer depuis
  // le tool appellerait ctx.reload() pendant que le run du tool est encore actif.
  pi.on("agent_settled", (_event, ctx) => {
    try {
      if (ctx.isIdle?.() !== true) return;
      const command = takePendingReloadCommand();
      if (!command) return;
      log("agent_settled: commande dispatchée");
      void Promise.resolve(pi.sendUserMessage(command, { deliverAs: "followUp", expandPromptTemplates: true })).catch((e: unknown) =>
        log(`agent_settled: envoi échoué — ${String(e instanceof Error ? e.message : e)}`),
      );
    } catch (e) {
      // Un bug du fork ne doit jamais tuer le process pi depuis un handler.
      log(`agent_settled: erreur — ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
    }
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Interne : relance Pi avec un prompt de continuation (émis par le tool " + TOOL_NAME + ")",
    handler: async (args, ctx: ExtensionCommandContext) => {
      let continuationPrompt: string;
      try {
        const token = args.trim().replace(new RegExp(`^/?${COMMAND_NAME}\\s*`), "").split(/\s+/)[0] ?? "";
        continuationPrompt = decodeReloadPayload(token).continuationPrompt;
      } catch (e) {
        log(`commande: payload invalide — ${String(e instanceof Error ? e.message : e)}`);
        ctx.ui?.notify?.("pi-reload-self-hardened : payload invalide", "error");
        return;
      }
      // Guard double : le dispatch vient d'agent_settled, mais si la réponse
      // n'est pas totalement finie, Pi consommerait la commande sans recharger
      // (« Wait for the current response to finish before reloading »).
      if (ctx.isIdle?.() !== true) {
        log("commande: agent pas idle — refusé, fin de réponse requise");
        ctx.ui?.notify?.("pi-reload-self-hardened : attends la fin de la réponse en cours avant de recharger", "warning");
        return;
      }
      storeContinuationPrompt(continuationPrompt);
      log("commande: reload en cours");
      await ctx.reload();
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Reload Pi and Continue",
    description:
      "Reload Pi extensions, skills, prompts, and themes, then continue with a provided prompt. WARNING: reload replaces the extension runtime and can reset in-memory extension state, timers, and hot-loaded resources. Only call this when the user requested a reload or extension changes require it. Requires confirm_state_loss: true.",
    parameters: Type.Object({
      continuation_prompt: Type.String({ description: "Non-empty prompt sent to the agent after Pi reloads." }),
      confirm_state_loss: Type.Boolean({ description: "Must be true. Confirms acceptance that reload may reset extension-maintained runtime state." }),
    }),
    async execute(_toolCallId, params: { continuation_prompt: string; confirm_state_loss: boolean }) {
      if (!params.confirm_state_loss) {
        return {
          content: [{ type: "text" as const, text: "Reload non programmé : confirm_state_loss: true est requis (le reload peut réinitialiser l'état en mémoire des extensions)." }],
          details: { queued: false, reason: "missing-confirmation" },
        };
      }
      let continuationPrompt: string;
      try {
        continuationPrompt = validateContinuationPrompt(params.continuation_prompt);
      } catch (e) {
        return { content: [{ type: "text" as const, text: String(e instanceof Error ? e.message : e) }], details: { queued: false, reason: "bad-prompt" } };
      }

      const token = encodeReloadPayload({ continuationPrompt });
      const command = `/${COMMAND_NAME} ${token}`;

      if (!storePendingReloadCommand(command)) {
        log("tool: une commande est déjà en file — refusé (dedup)");
        return {
          content: [{ type: "text" as const, text: "Un rechargement est déjà en file ; la continuation existante partira au prochain settlement." }],
          details: { queued: false, reason: "already-queued" },
        };
      }
      log("tool: commande stockée, en attente d'agent_settled");
      return {
        content: [{ type: "text" as const, text: "Rechargement en file : la commande part dès que l'agent est totalement settled (événement agent_settled), le prompt de continuation arrivera après le reload." }],
        details: { queued: true, reason: "pending-agent-settled" },
      };
    },
  });

  log("extension chargée (fork local, dispatch agent_settled, API publique uniquement)");
}
