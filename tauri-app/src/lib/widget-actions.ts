/** A tap on a home-screen widget. */
export interface WidgetAction {
  name: string;
  file: string | null;
  /** Which template, set only for a template launch (`template`). */
  template: string | null;
}

/**
 * Reads `magical-merchant://widget/<name>?file=<filename>`.
 * Only a template launch carries `?name=<template name>`.
 * A deep link that is not a widget (the auth callback) gives `null`.
 */
export function parseWidgetAction(raw: string): WidgetAction | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.hostname !== "widget") {
    return null;
  }

  const name = url.pathname.replace(/^\/+/u, "");
  if (!name) {
    return null;
  }

  return {
    name,
    file: url.searchParams.get("file"),
    template: url.searchParams.get("name"),
  };
}

/** Launch URLs also include the auth callback. Takes the first widget link. */
export function firstWidgetAction(urls: readonly string[]): WidgetAction | null {
  for (const url of urls) {
    const action = parseWidgetAction(url);
    if (action) {
      return action;
    }
  }
  return null;
}
