import { createContext, useContext, useEffect, useMemo, useState } from "react";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import es from "./locales/es.json";
import { invoke } from "@tauri-apps/api/core";

export const LOCALES = [
  { id: "system", label: "System" },
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-TW", label: "繁體中文" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
  { id: "es", label: "Español" },
];

const catalogs = { en, "zh-CN": zhCN, "zh-TW": zhTW, ja, ko, es };
const I18nContext = createContext(null);

function detectSystemLocale() {
  const locale = navigator.language?.toLowerCase() ?? "en";
  if (locale.startsWith("zh-tw") || locale.startsWith("zh-hk")) return "zh-TW";
  if (locale.startsWith("zh")) return "zh-CN";
  if (locale.startsWith("ja")) return "ja";
  if (locale.startsWith("ko")) return "ko";
  if (locale.startsWith("es")) return "es";
  return "en";
}

function resolveLocale(preference) {
  return preference === "system" ? detectSystemLocale() : preference;
}

function interpolate(value, variables) {
  return value.replace(/\{(\w+)\}/g, (_, key) => String(variables?.[key] ?? `{${key}}`));
}

export function I18nProvider({ children }) {
  const [preference, setPreference] = useState(() => {
    try { return localStorage.getItem("habor.language") || "system"; } catch { return "system"; }
  });
  const locale = resolveLocale(preference);

  useEffect(() => {
    try { localStorage.setItem("habor.language", preference); } catch { /* storage is optional in preview */ }
    document.documentElement.lang = locale;
    invoke("set_menu_language", { language: locale }).catch(() => undefined);
  }, [preference, locale]);

  const value = useMemo(() => ({
    preference,
    locale,
    languages: LOCALES,
    setLanguage: setPreference,
    t(key, variables) {
      const message = catalogs[locale]?.[key] ?? catalogs.en[key] ?? key;
      return interpolate(message, variables);
    },
  }), [locale, preference]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
