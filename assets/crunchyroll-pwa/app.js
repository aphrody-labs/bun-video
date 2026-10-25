// SPDX-License-Identifier: Apache-2.0
import { locales, languageNames, resolveLanguage } from "./locales.js";
const select = document.querySelector("#language");
const installButton = document.querySelector("#install");
let prompt;
let installationMessage = "installUnavailable";
let shellFailed = false;
let saved;
try {
  saved = localStorage.getItem("shortcut-language");
} catch {
  /* Local preference storage is optional. */
}
let language = resolveLanguage(saved || navigator.language);
for (const [code, name] of Object.entries(languageNames)) {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = name;
  select.append(option);
}
function render() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.title = locales[language].appName;
  select.value = language;
  for (const element of document.querySelectorAll("[data-message]"))
    element.textContent = locales[language][element.dataset.message] || locales.en[element.dataset.message];
  document.querySelector("#installation").textContent = locales[language][installationMessage];
  document.querySelector("#connectivity").textContent =
    locales[language][shellFailed ? "shellError" : navigator.onLine ? "online" : "offline"];
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
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  prompt = event;
  installButton.disabled = false;
});
installButton.addEventListener("click", async () => {
  if (!prompt) return;
  const pending = prompt;
  prompt = undefined;
  installButton.disabled = true;
  try {
    await pending.prompt();
    installationMessage = (await pending.userChoice).outcome === "accepted" ? "installed" : "installDismissed";
  } catch {
    installationMessage = "installUnavailable";
  }
  render();
});
window.addEventListener("appinstalled", () => {
  prompt = undefined;
  installButton.disabled = true;
  installationMessage = "installed";
  render();
});
window.addEventListener("online", render);
window.addEventListener("offline", render);
render();
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/pwa/sw.js", { scope: "/pwa/" }).catch(() => {
    shellFailed = true;
    render();
  });
} else {
  shellFailed = true;
  render();
}
