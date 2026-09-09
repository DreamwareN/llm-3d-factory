export interface LastModel {
  providerProfileId: string;
  model: string;
}

const LAST_MODEL_KEY = 'llm3d:last-model';

export function readLastModel(): LastModel | null {
  try {
    const raw = window.localStorage.getItem(LAST_MODEL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastModel>;
    if (
      typeof parsed.providerProfileId !== 'string' ||
      typeof parsed.model !== 'string' ||
      !parsed.providerProfileId ||
      !parsed.model
    ) {
      return null;
    }
    return { providerProfileId: parsed.providerProfileId, model: parsed.model };
  } catch {
    return null;
  }
}

export function writeLastModel(value: LastModel): void {
  try {
    window.localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(value));
  } catch {
    // ignore quota / privacy mode errors
  }
}
