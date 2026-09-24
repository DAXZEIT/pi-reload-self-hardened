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
 * logging fichier (le PR est silencieux), `Promise.resolve` sur
 * `sendUserMessage` (le binding d'extension retourne `undefined`, wrapper
 * interne sans return — un `.catch` direct crashait pi, payé le 2026-09-24),
 * et balayage ABI des slots globalThis (globalThis survit au reload : un
 * renommage de slot EN VOL perdit la continuation le 2026-09-24 — on lit
 * toutes les variantes `__piReloadSelf*ContinuationPrompt` /
 * `__piReloadSelf*PendingCommand` plutôt qu'un nom exact).
 *
 * Correctifs revue adversariale 2026-09-25 (C1/C2a/C2c/C3/N1/N2/N5) : la
 * continuation n'est plus livrée que sur session_start(reload) et ne survit
 * jamais à un reload échoué ; une commande pending jetée par un changement de
 * session ou un send synchrone en échec est restaurée (retry au prochain
 * settlement) ; le refus du garde d'idle remet la commande en file (plafond
 * 3) ; chaque perte d'état prévient l'utilisateur — jamais de silence.
 * 2e passe (F1-F4, 2026-09-25) : le refus du garde d'idle re-stocke la
 * commande reconstruite `/<nom> <token>` — le runtime réel ne passe au
 * handler que le token après l'espace (agent-session.js:1336-1348), un token
 * nu échouerait à la gate `text.startsWith("/")` (agent-session.js:1218) ;
 * les plafonds (refus idle, re-stores après send synchrone en échec) comptent
 * PAR COMMANDE EN FILE — reset uniquement sur une nouvelle file, jamais au
 * dispatch (chaque refus est précédé d'un dispatch, sinon inatteignable) ;
 * le re-store après échec d'envoi est plafonné à 3 (F3) et un échec de dedup
 * au re-store est signalé au lieu de promettre un retry (F4).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, renameSync, statSync } from "node:fs";

const COMMAND_NAME = "pi-reload-self-hardened-run";
const TOOL_NAME = "pi_extension_dev_reload_self";
const CONTINUATION_SLOT = "__piReloadSelfHardenedContinuationPrompt";
const PENDING_COMMAND_SLOT = "__piReloadSelfHardenedPendingCommand";
// Compteur de refus du garde d'idle (N1) : volontairement hors des patterns
// ContinuationPrompt/PendingCommand — c'est un compteur de runtime, pas un
// état à migrer entre versions, il ne doit JAMAIS être balayé comme un slot ABI.
const RETRY_COUNT_SLOT = "__piReloadSelfHardenedRetryCount";
// Plafond de refus du garde d'idle avant abandon (N1).
const IDLE_GUARD_MAX_RETRIES = 3;
// Compteur de re-stores après un send synchrone en échec (C2c, plafonné F3) :
// même contrainte que RETRY_COUNT_SLOT — hors des patterns
// ContinuationPrompt/PendingCommand, jamais balayé comme un slot ABI.
const SEND_RETRY_COUNT_SLOT = "__piReloadSelfHardenedSendRetries";
// Plafond de re-stores après échec d'envoi synchrone avant abandon (F3).
const SEND_MAX_RETRIES = 3;
// Garde-fou taille du log (N5) : au-delà, on renomme en <fichier>.1 (écrasé).
const LOG_MAX_BYTES = 1_000_000;
// Surchargeable via env pour l'isolation des tests.
const LOG_FILE = process.env.PI_RELOAD_SELF_HARDENED_LOG ?? "/tmp/pi-reload-self-hardened.log";

function log(msg: string): void {
  try {
    if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // diagnostic optionnel — ne doit JAMAIS jeter dans le flux
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

// ABI entre runtimes : globalThis survit au remplacement du runtime, donc le
// code chargé après un reload peut lire un slot écrit par une version
// antérieure (renommage en vol — payé le 2026-09-24, local→hardened). On
// balaye toutes les variantes du slot plutôt qu'un nom exact.
// NB (N3) : « le plus récemment écrit gagne » s'appuie sur l'ordre d'insertion
// des clés non-entières d'un objet JS (un delete+ré-insertion déplace une clé
// en fin) — une hypothèse qui marche en pratique, pas une garantie du langage.
const CONTINUATION_SLOT_PATTERN = /^__piReloadSelf\w*ContinuationPrompt$/;
// Même traitement pour la commande pending : c'est le même risque de
// renommage en vol, un cran plus tôt dans le cycle (N2b).
const PENDING_COMMAND_SLOT_PATTERN = /^__piReloadSelf\w*PendingCommand$/;

function takeContinuationPrompt(): string | undefined {
  const state = globalState();
  let latest: string | undefined;
  for (const key of Object.keys(state)) {
    if (CONTINUATION_SLOT_PATTERN.test(key)) {
      const value = state[key];
      if (typeof value === "string") latest = value;
      else log(`slot legacy non-string (${typeof value}) jeté`); // N2a
      delete state[key];
    }
  }
  return latest;
}

function storePendingReloadCommand(command: string): boolean {
  const state = globalState();
  // Dedup sur toutes les variantes ABI : une commande déjà en file (y compris
  // écrite par une version antérieure) n'est pas remplacée.
  for (const key of Object.keys(state)) {
    if (PENDING_COMMAND_SLOT_PATTERN.test(key) && typeof state[key] === "string") return false; // déjà en file
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

// session_start : une commande en attente appartient au run qui l'a créée —
// si la session est remplacée avant son settlement, elle est abandonnée.
// Retourne la commande jetée (C2a : prévenir l'utilisateur) ou undefined.
function clearPendingReloadCommand(): string | undefined {
  return takePendingReloadCommand();
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
  // Après un reload, le prompt de continuation (stocké dans globalThis, qui
  // survit à la mort du runtime) repart en message user follow-up — mais
  // UNIQUEMENT si ce session_start est le nôtre (reason "reload"). Toute
  // autre raison signifie que la session a changé sans rapport avec le
  // rechargement : un état résiduel y serait injecté à tort.
  pi.on("session_start", (event, ctx) => {
    try {
      const reason = String((event as { reason?: string }).reason);

      // C2a : une commande pending jetée ici = un rechargement demandé puis
      // abandonné sans dispatch (la session a fork/new/resume avant le
      // settlement). On prévient, on n'efface pas en silence.
      const droppedPending = clearPendingReloadCommand();
      if (droppedPending) {
        log(`session_start(${reason}): commande pending abandonnée (${droppedPending.length} chars)`);
        ctx.ui?.notify?.("pi-reload-self-hardened : rechargement en attente abandonné — la session a changé avant le settlement", "warning");
      }

      // C3 : la continuation n'est livrée QUE sur un session_start causé par
      // notre reload ; sinon elle serait injectée dans une session qui n'a
      // rien demandé (c'est le scénario C1 : reload échoué puis session new).
      if (reason !== "reload") {
        const residual = takeContinuationPrompt();
        if (residual !== undefined) {
          log(`session_start(${reason}): continuation résiduelle jetée (${residual.length} chars)`);
          ctx.ui?.notify?.("pi-reload-self-hardened : continuation résiduelle jetée — la session a changé", "warning");
        }
        return;
      }

      const continuationPrompt = takeContinuationPrompt();
      if (continuationPrompt) {
        log(`session_start(${reason}): continuation envoyée (${continuationPrompt.length} chars)`);
        // Le binding d'extension peut retourner undefined (wrapper interne sans
        // return) : Promise.resolve évite un crash et reste compatible avec un
        // futur pi qui retournerait une vraie promise.
        void Promise.resolve(pi.sendUserMessage(continuationPrompt, { deliverAs: "followUp" })).catch((e: unknown) =>
          log(`continuation: envoi échoué — ${String(e instanceof Error ? e.message : e)}`),
        );
      } else {
        // Perte de continuation après un reload : ne jamais laisser l'utilisateur
        // deviner pourquoi le rechargement ne s'est pas enchaîné.
        log("session_start(reload): AUCUNE continuation — la main est rendue à l'utilisateur");
        ctx.ui?.notify?.("pi-reload-self-hardened : rechargement effectué SANS continuation (perdue ou jamais stockée) — la main t'est rendue", "warning");
      }
    } catch (e) {
      // Même défense que agent_settled : 0.87.1 isole déjà chaque handler
      // dans runner.emit, ce try/catch est un filet pour des runners futurs
      // sans isolation par handler — un bug du fork ne doit jamais tuer pi.
      log(`session_start: erreur — ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
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
      try {
        void Promise.resolve(pi.sendUserMessage(command, { deliverAs: "followUp", expandPromptTemplates: true })).catch((e: unknown) =>
          log(`agent_settled: envoi échoué — ${String(e instanceof Error ? e.message : e)}`),
        );
        // NB (F2) : PAS de reset des compteurs ici — chaque refus du garde
        // d'idle est précédé d'un dispatch, un reset au dispatch rendrait les
        // plafonds inatteignables (retry sans borne). Ils ne repartent de
        // zéro que sur une nouvelle file (tool).
      } catch (e) {
        // C2c : sendUserMessage a throw de façon synchrone (runtime stale
        // après remplacement de session, …). La commande était déjà consommée
        // du slot : on la restaure pour que le prochain settlement réessaie,
        // et on prévient l'utilisateur au lieu de perdre le rechargement en
        // silence. F3 : plafonné — un binding qui throw en permanence ne doit
        // pas re-dispatcher + prévenir à chaque settlement indéfiniment.
        // NB : une commande restaurée survit dans globalThis et sera reprise
        // par le handler agent_settled du PROCHAIN runtime après un
        // remplacement de session — c'est voulu, pas un bug.
        const sendRetries = sendRetryCount() + 1;
        globalState()[SEND_RETRY_COUNT_SLOT] = sendRetries;
        if (sendRetries > SEND_MAX_RETRIES) {
          // Plafond atteint : la commande est JETÉE (on vide le slot au cas
          // où un chemin ne l'aurait pas consommé) et on arrête de réessayer.
          takePendingReloadCommand();
          log(`agent_settled: envoi synchrone en échec — ${sendRetries} échecs, abandon — ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
          ctx.ui?.notify?.("pi-reload-self-hardened : rechargement abandonné après 3 échecs d'envoi — relance le tool", "error");
          return;
        }
        storePendingReloadCommand(command);
        log(`agent_settled: envoi synchrone en échec — commande restaurée (${sendRetries}/${SEND_MAX_RETRIES}) — ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
        ctx.ui?.notify?.("pi-reload-self-hardened : envoi de la commande de rechargement échoué — nouvelle tentative au prochain settlement", "warning");
      }
    } catch (e) {
      // Un bug du fork ne doit jamais tuer le process pi depuis un handler.
      log(`agent_settled: erreur — ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
    }
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Interne : relance Pi avec un prompt de continuation (émis par le tool " + TOOL_NAME + ")",
    handler: async (args, ctx: ExtensionCommandContext) => {
      let continuationPrompt: string;
      let token: string;
      try {
        token = args.trim().replace(new RegExp(`^/?${COMMAND_NAME}\\s*`), "").split(/\s+/)[0] ?? "";
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
        // N1 : au lieu de jeter la commande (déjà consommée du slot par
        // agent_settled), on la remet en file pour le prochain settlement,
        // avec un plafond pour éviter une boucle sur une session jamais idle.
        // F2 : le compteur n'est PAS remis à zéro au dispatch — chaque refus
        // est précédé d'un dispatch, un reset au dispatch rendrait le
        // plafond inatteignable (retry sans borne). Il compte les refus PAR
        // COMMANDE EN FILE et ne repart de zéro que sur une nouvelle file
        // (tool). Cycle réel : file → [dispatch, refus] ×3 → 4e refus = abandon.
        const refusals = retryCount() + 1;
        globalState()[RETRY_COUNT_SLOT] = refusals;
        if (refusals > IDLE_GUARD_MAX_RETRIES) {
          // Plafond atteint : la commande est JETÉE (on vide le slot au cas
          // où un chemin ne l'aurait pas consommé) et on arrête de réessayer.
          takePendingReloadCommand();
          log(`commande: agent pas idle — ${refusals} refus, abandon`);
          ctx.ui?.notify?.("pi-reload-self-hardened : rechargement abandonné après 3 refus du garde d'idle", "error");
          return;
        }
        // F1 : sur le runtime réel, le handler ne reçoit que le TOKEN NU —
        // `args = text.slice(spaceIndex + 1)`, le texte après le premier
        // espace (_tryExecuteExtensionCommand, agent-session.js:1336-1348).
        // Re-stocker `args` stockerait ce token nu : au retry, la gate
        // `text.startsWith("/")` (agent-session.js:1218) le laisserait passer
        // comme texte chat vers le LLM — la commande ne tournerait plus
        // jamais, le rechargement s'évanouirait en silence. On re-stocke la
        // commande reconstruite, re-dispatchable quelle que soit la forme
        // d'`args` reçue (token nu du runtime réel, ou texte complet collé
        // par l'utilisateur — le décodage extrait `token` dans les deux cas).
        const restored = `/${COMMAND_NAME} ${token}`;
        // F4 : si le slot est déjà occupé (un tool a mis en file entre le
        // dispatch et le refus), le re-store échouerait en silence — ne pas
        // promettre un retry qui n'aura pas lieu.
        if (!storePendingReloadCommand(restored)) {
          log("commande: agent pas idle — remise en file refusée (slot déjà occupé)");
          ctx.ui?.notify?.("pi-reload-self-hardened : une autre commande de rechargement est déjà en file — la présente est abandonnée", "warning");
          return;
        }
        log(`commande: agent pas idle — refusé (${refusals}/${IDLE_GUARD_MAX_RETRIES}), remis en file`);
        ctx.ui?.notify?.("pi-reload-self-hardened : attends la fin de la réponse en cours avant de recharger — nouvelle tentative au prochain settlement", "warning");
        return;
      }
      storeContinuationPrompt(continuationPrompt);
      log("commande: reload en cours");
      try {
        await ctx.reload();
      } catch (e) {
        // C1 : un reload qui throw laisse la continuation dans globalThis, où
        // le PROCHAIN session_start (n'importe quelle raison) l'injecterait
        // dans une session sans rapport. On la jette maintenant — elle ne
        // doit JAMAIS survivre à un reload échoué — et on prévient.
        takeContinuationPrompt();
        log(`commande: reload échoué — continuation jetée — ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
        ctx.ui?.notify?.("pi-reload-self-hardened : rechargement échoué, continuation jetée, relance le tool", "error");
      }
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
      // File fraîche : les compteurs de refus du garde d'idle et d'échecs
      // d'envoi synchrone repartent de zéro — ils comptent par commande en
      // file, pas par dispatch (F2/F3).
      globalState()[RETRY_COUNT_SLOT] = 0;
      globalState()[SEND_RETRY_COUNT_SLOT] = 0;
      log("tool: commande stockée, en attente d'agent_settled");
      return {
        content: [{ type: "text" as const, text: "Rechargement en file : la commande part dès que l'agent est totalement settled (événement agent_settled), le prompt de continuation arrivera après le reload." }],
        details: { queued: true, reason: "pending-agent-settled" },
      };
    },
  });

  log("extension chargée (fork local, dispatch agent_settled, API publique uniquement)");
}
