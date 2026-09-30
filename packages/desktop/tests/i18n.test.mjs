import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const locales = ["en", "zh-CN", "zh-TW", "ja", "ko", "es"];
const localeDir = join(process.cwd(), "src", "locales");

test("desktop locale catalogs expose the same interaction keys", async () => {
  const catalogs = await Promise.all(locales.map(async (locale) => [
    locale,
    JSON.parse(await readFile(join(localeDir, `${locale}.json`), "utf8")),
  ]));
  const englishKeys = Object.keys(catalogs[0][1]).sort();
  for (const [locale, catalog] of catalogs) {
    assert.deepEqual(Object.keys(catalog).sort(), englishKeys, `${locale} is missing a translation key`);
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, "string", `${locale}.${key} must be a string`);
    }
  }
});
