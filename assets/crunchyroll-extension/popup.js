// SPDX-License-Identifier: Apache-2.0
import { locales, languageNames, resolveLanguage } from "./locales.js";
const select = document.querySelector("#language");
for (const [code, name] of Object.entries(languageNames)) {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = name;
  select.append(option);
}
let saved;
try {
  saved = localStorage.getItem("shortcut-language");
} catch {
  /* Local preference storage is optional. */
}
let language = resolveLanguage(saved || globalThis.chrome?.i18n?.getUILanguage?.() || navigator.language);
function render() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.title = locales[language].appName;
  select.value = language;
  for (const element of document.querySelectorAll("[data-message]"))
    element.textContent = locales[language][element.dataset.message] || locales.en[element.dataset.message];
}
select.addEventListener("change", () => {
  language = resolveLanguage(select.value);
  try {
    localStorage.setItem("shortcut-language", language);
  } catch {
    /* Local preference storage is optional. */
  }
  render();
});
render();
