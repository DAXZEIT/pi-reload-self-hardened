/**
 * pi-reload-self-hardened — fork local de npm:pi-reload-self (0.1.1), 2026-09-24.
 *
 * Pourquoi le fork : la version npm patche ExtensionRunner.prototype.createContext
 * pour exposer reload() au context tool. Sur pi 0.87.x, le runner construit le
 * context tool par projection à liste blanche sans reload — le patch s'applique
 * mais est immédiatement filtré.
 *
 * Mécanisme (API publique uniquement, aucun monkey-patching) :
 *   tool → storePendingReloadCommand (globalThis, dedup)
 *        → événement agent_settled (exécution « fully settled »)
 *        → pi.sendUserMessage("/pi-reload-self-hardened-run", { deliverAs: "followUp",
 *             expandPromptTemplates: true })
 *        → prompt() dispatche la commande extension
 *        → handler : guard isIdle + await ctx.reload()
 *        → session_start(reason: "reload")
 *        → sendUserMessage("reload successful", { deliverAs: "followUp" })
 *        → nouveau turn, contexte conversationnel intact.
 *
 * Architecture alignée sur le PR #1 de clankercode/pi-reload-self (limitsurface,
 * « Use public settled dispatch ») : événement agent_settled au lieu d'un timer
 * de polling, guard d'idle DANS la commande (corrige la course « commande
 * consommée sans reload »), dedup de la commande en attente.
 *
 * Hardening local :
 * - logging fichier (le PR est silencieux)
 * - Promise.resolve sur sendUserMessage (le binding d'extension retourne undefined)
 * - try/catch d'isolation autour des handlers
 * - balayage ABI des slots PendingCommand entre runtimes
 * - no-silent-failure sur les pertes d'état
 * - caps de retry pour le garde d'idle et les sends synchrones
 */ 
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, renameSync, statSync } from "node:fs";

const COMMAND_NAME = "pi-reload-self-hardened-run";
const TOOL_NAME = "pi_extension_dev_reload_self";
const RELOAD_COMMAND = `/${COMMAND_NAME}`;
const RELOAD_SUCCESS_MESSAGE = "reload successful";
const PENDING_COMMAND_SLOT = "__piReloadSelfHardenedPendingCommand";

// Compteur de refus du garde d'idle : volontairement hors des patterns ABI.
const RETRY_COUNT_SLOT = "__piReloadSelfHardenedRetryCount";
const IDLE_GUARD_MAX_RETRIES = 3;

// Compteur de re-stores après un send synchrone en échec : volontairement
// hors des patterns ABI.
const SEND_RETRY_COUNT_SLOT = "__piReloadSelfHardenedSendRetries";
const SEND_MAX_RETRIES = 3;

// Garde-fou taille du log : au-delà, on renomme en <fichier>.1 (écrasé).
const LOG_MAX_BYTES = 1_000_000;
const LOG_FILE = process.env.PI_RELOAD_SELF_HARDENED_LOG ?? "/tmp/pi-reload-self-hardened.log";

function log(msg: string): void {
  try {
    let size = 0;
    try {
      size = statSync(LOG_FILE).size;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
    }
    if (size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // Diagnostic optionnel — ne doit JAMAIS jeter dans le flux.
  }
}

function globalState(): Record<string, unknown> {
  return globalThis as Record<string, unknown>;
}

// ABI entre runtimes : globalThis survit au remplacement du runtime, donc le
// code chargé après un reload peut lire un slot écrit par une version
// antérieure (renommage en vol). On balaie toutes les variantes du slot.
const PENDING_COMMAND_SLOT_PATTERN = /^__piReloadSelf\w*PendingCommand$/;

function storePendingReloadCommand(command: string): boolean {
  const state = globalState();
  for (const key of Object.keys(state)) {
    if (PENDING_COMMAND_SLOT_PATTERN.test(key) && typeof state[key] === "string") {
      return false;
    }
  }
  state[PENDING_COMMAND_SLOT] = command;
  return true;
}

function takePendingReloadCommand(): string | undefined {
  const state = globalState();
  let latest: string | undefined;
  for (const key of Object.keys(state)) {
    if (PENDING_COMMAND_SLOT_PATTERN.test(key)) {
      const value = state[key];
      if (typeof value === "string") latest = value;
      else log(`slot pending non-string (${typeof value}) jeté`);
      delete state[key];
    }
  }
  return latest;
}

function retryCount(): number {
  const value = globalState()[RETRY_COUNT_SLOT];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sendRetryCount(): number {
  const value = globalState()[SEND_RETRY_COUNT_SLOT];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export default async function reloadSelfHardenedExtension(pi: ExtensionAPI): Promise<void> {
  pi.on("session_start", (event, ctx) => {
    try {
      const reason = String((event as { reason?: string }).reason);

      const droppedPending = takePendingReloadCommand();
      if (droppedPending) {
        log(`session_start(${reason}): commande pending abandonnée (${droppedPending.length} chars)`);
        ctx.ui?.notify?.(
          "pi-reload-self-hardened : rechargement en attente abandonné — la session a changé avant le settlement",
          "warning",
        );
      }

      // Le contexte conversationnel survit au reload : le nouveau runtime n'a
      // besoin que d'un petit signal explicite confirmant que le reload est terminé.
      if (reason !== "reload") return;

      log(`session_start(${reason}): signal de succès envoyé (${RELOAD_SUCCESS_MESSAGE.length} chars)`);
      try {
        void Promise.resolve(
          pi.sendUserMessage(RELOAD_SUCCESS_MESSAGE, { deliverAs: "followUp" }),
        ).catch((e: unknown) => {
          log(`session_start(reload): envoi du signal de succès échoué — ${String(e instanceof Error ? e.message : e)}`);
          ctx.ui?.notify?.(
            "pi-reload-self-hardened : le reload est terminé, mais le signal de succès n'a pas pu être envoyé",
            "warning",
          );
        });
      } catch (e) {
        log(
          `session_start(reload): envoi synchrone du signal de succès échoué — ${String(
            e instanceof Error ? (e.stack ?? e.message) : e,
          )}`,
        );
        ctx.ui?.notify?.(
          "pi-reload-self-hardened : le reload est terminé, mais le signal de succès n'a pas pu être envoyé",
          "warning",
        );
      }
    } catch (e) {
      log(`session_start: erreur — ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
    }
  });

  // Le dispatch volontairement ici et nulle part ailleurs : Pi expand/dispatch
  // les slash commands avant de mettre les messages en file.
  pi.on("agent_settled", (_event, ctx) => {
    try {
      if (ctx.isIdle?.() !== true) return;
      const command = takePendingReloadCommand();
      if (!command) return;
      log("agent_settled: commande dispatchée");
      try {
        void Promise.resolve(
          pi.sendUserMessage(command, { deliverAs: "followUp", expandPromptTemplates: true }),
        ).catch((e: unknown) =>
          log(`agent_settled: envoi échoué — ${String(e instanceof Error ? e.message : e)}`),
        );
      } catch (e) {
        const sendRetries = sendRetryCount() + 1;
        globalState()[SEND_RETRY_COUNT_SLOT] = sendRetries;
        if (sendRetries > SEND_MAX_RETRIES) {
          takePendingReloadCommand();
          log(
            `agent_settled: envoi synchrone en échec — ${sendRetries} échecs, abandon — ${String(
              e instanceof Error ? (e.stack ?? e.message) : e,
            )}`,
          );
          ctx.ui?.notify?.(
            "pi-reload-self-hardened : rechargement abandonné après 3 échecs d'envoi — relance le tool",
            "error",
          );
          return;
        }
        storePendingReloadCommand(command);
        log(
          `agent_settled: envoi synchrone en échec — commande restaurée (${sendRetries}/${SEND_MAX_RETRIES}) — ${String(
            e instanceof Error ? e.message : e,
          )}`,
        );
        ctx.ui?.notify?.(
          "pi-reload-self-hardened : envoi de la commande de rechargement échoué — nouvelle tentative au prochain settlement",
          "warning",
        );
      }
    } catch (e) {
      log(`agent_settled: erreur — ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
    }
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Interne : recharge Pi puis confirme avec « reload successful »",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (ctx.isIdle?.() !== true) {
        const refusals = retryCount() + 1;
        globalState()[RETRY_COUNT_SLOT] = refusals;

        if (refusals > IDLE_GUARD_MAX_RETRIES) {
          takePendingReloadCommand();
          log(`commande: agent pas idle — ${refusals} refus, abandon`);
          ctx.ui?.notify?.(
            "pi-reload-self-hardened : rechargement abandonné après 3 refus du garde d'idle",
            "error",
          );
          return;
        }

        if (!storePendingReloadCommand(RELOAD_COMMAND)) {
          log("commande: agent pas idle — remise en file refusée (slot déjà occupé)");
          ctx.ui?.notify?.(
            "pi-reload-self-hardened : une autre commande de rechargement est déjà en file — la présente est abandonnée",
            "warning",
          );
          return;
        }

        log(`commande: agent pas idle — refusé (${refusals}/${IDLE_GUARD_MAX_RETRIES}), remis en file`);
        ctx.ui?.notify?.(
          "pi-reload-self-hardened : attends la fin de la réponse en cours avant de recharger — nouvelle tentative au prochain settlement",
          "warning",
        );
        return;
      }

      log("commande: reload en cours");
      try {
        await ctx.reload();
      } catch (e) {
        log(`commande: reload échoué — ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
        ctx.ui?.notify?.(
          "pi-reload-self-hardened : rechargement échoué — la main t'est rendue",
          "error",
        );
      }
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Reload Pi and Continue",
    description:
      "Reload Pi extensions, skills, prompts, and themes, then send a small post-reload success signal. " +
      "The conversation context is preserved; the signal is exactly « reload successful ». " +
      "WARNING: reload can reset extension-maintained runtime state. Only call this when the user requested " +
      "a reload or extension changes require it. Requires confirm_state_loss: true.",
    parameters: Type.Object({
      confirm_state_loss: Type.Boolean({
        description: "Must be true. Confirms acceptance that reload may reset extension-maintained runtime state.",
      }),
    }),
    async execute(_toolCallId, params: { confirm_state_loss: boolean }) {
      if (!params.confirm_state_loss) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Reload non programmé : confirm_state_loss: true est requis (le reload peut réinitialiser l'état en mémoire des extensions).",
            },
          ],
          details: { queued: false, reason: "missing-confirmation" },
        };
      }

      if (!storePendingReloadCommand(RELOAD_COMMAND)) {
        log("tool: une commande est déjà en file — refusé (dedup)");
        return {
          content: [
            {
              type: "text" as const,
              text: "Un rechargement est déjà en file ; il partira au prochain settlement.",
            },
          ],
          details: { queued: false, reason: "already-queued" },
        };
      }

      globalState()[RETRY_COUNT_SLOT] = 0;
      globalState()[SEND_RETRY_COUNT_SLOT] = 0;
      log("tool: commande stockée, en attente d'agent_settled");
      return {
        content: [
          {
            type: "text" as const,
            text: "Rechargement en file : la commande part dès que l'agent est totalement settled (événement agent_settled).",
          },
        ],
        details: { queued: true, reason: "pending-agent-settled" },
      };
    },
  });

  log("extension chargée (fork local, dispatch agent_settled, signal post-reload minimal)");
}
