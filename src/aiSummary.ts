/**
 * Optional AI summary, limited to the codebase.
 *
 * What it does: asks a language model "what does this code do, in the
 * context of this project?" and shows the answer in its own clearly
 * labelled section.
 *
 * Guarantees:
 * - Off by default (setting `nexus.ai.enabled`), and Nexus asks the user
 *   once before any source code is sent.
 * - The model only receives text from the workspace: the selection,
 *   the open file (bounded), definitions in other files and files that
 *   import this one. It gets no tools and no web access, and it is told
 *   to use only what it was given.
 * - The answer must cite line numbers from the numbered context. Any
 *   citation that does not match a line Nexus actually sent is removed,
 *   and the panel shows that the summary is AI-generated.
 */
import * as vscode from "vscode";

import { buildPrompt, parseAnswer, SYSTEM_PROMPT, type AiRequest, type AiResult } from "./aiPrompt";

export type { AiContextFile, AiRequest, AiResult } from "./aiPrompt";

const CONSENT_KEY = "nexus.ai.consentGiven";
const REQUEST_TIMEOUT_MS = 45_000;

export class AiSummarizer {
  constructor(private readonly context: vscode.ExtensionContext) {}

  isEnabled(): boolean {
    return vscode.workspace.getConfiguration("nexus").get<boolean>("ai.enabled", false);
  }

  async summarize(request: AiRequest, token: vscode.CancellationToken): Promise<AiResult> {
    if (!this.isEnabled()) {
      return { status: "disabled", message: "AI summaries are off. Turn on the setting “Nexus › AI: Enabled” to use them." };
    }
    if (!vscode.workspace.isTrusted) {
      return { status: "disabled", message: "AI summaries are disabled in untrusted workspaces." };
    }
    if (!(await this.ensureConsent())) {
      return { status: "declined", message: "AI summary skipped: permission to send code was not given." };
    }

    const { prompt, sentLines, filesSent } = buildPrompt(request);
    const provider = vscode.workspace.getConfiguration("nexus").get<string>("ai.provider", "vscode");

    try {
      const { text, model } =
        provider === "gemini"
          ? await this.askGemini(prompt, token)
          : await this.askVscodeModel(prompt, token);
      return parseAnswer(text, model, sentLines, filesSent);
    } catch (error) {
      if (error instanceof UnavailableError) {
        return { status: "unavailable", message: error.message };
      }
      return { status: "failed", message: `The AI request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async ensureConsent(): Promise<boolean> {
    if (this.context.globalState.get<boolean>(CONSENT_KEY)) {
      return true;
    }
    const allow = "Allow";
    const choice = await vscode.window.showWarningMessage(
      "Nexus AI summaries send the selected code and related files from this workspace to the AI model you chose in settings. Nothing from the web is used. Allow this?",
      { modal: true },
      allow,
    );
    if (choice === allow) {
      await this.context.globalState.update(CONSENT_KEY, true);
      return true;
    }
    return false;
  }

  private async askVscodeModel(prompt: string, token: vscode.CancellationToken): Promise<{ text: string; model: string }> {
    if (!("lm" in vscode) || typeof vscode.lm?.selectChatModels !== "function") {
      throw new UnavailableError("This version of VS Code does not offer language model access.");
    }
    const family = vscode.workspace.getConfiguration("nexus").get<string>("ai.modelFamily", "").trim();
    const models = await vscode.lm.selectChatModels(family ? { family } : {});
    const model = models[0];
    if (!model) {
      throw new UnavailableError(
        "No AI model is available in VS Code. Sign in to GitHub Copilot (or another model provider), or set “Nexus › AI: Provider” to Gemini.",
      );
    }

    // System rules go in the first user message: the VS Code API has no separate system role.
    const messages = [vscode.LanguageModelChatMessage.User(`${SYSTEM_PROMPT}\n\n${prompt}`)];
    const response = await withTimeout(model.sendRequest(messages, { justification: "Nexus explains the selected code using files from this workspace." }, token));
    let text = "";
    for await (const fragment of response.text) {
      text += fragment;
      if (text.length > 20_000) {
        break;
      }
    }
    return { text, model: model.name || model.family || model.id };
  }

  private async askGemini(prompt: string, token: vscode.CancellationToken): Promise<{ text: string; model: string }> {
    const apiKey = await this.context.secrets.get("nexus.geminiApiKey");
    if (!apiKey) {
      throw new UnavailableError("No Gemini API key is stored. Run “Nexus: Set Gemini API Key” first.");
    }
    const model = vscode.workspace.getConfiguration("nexus").get<string>("ai.geminiModel", "gemini-3-flash-preview");
    const controller = new AbortController();
    const cancel = token.onCancellationRequested(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // No tools and no search grounding: the model sees only the prompt text.
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Gemini returned HTTP ${response.status}.`);
      }
      const body = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
      return { text, model };
    } finally {
      clearTimeout(timer);
      cancel.dispose();
    }
  }
}

class UnavailableError extends Error {}

function withTimeout<T>(promise: Thenable<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the model did not answer in time")), REQUEST_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

