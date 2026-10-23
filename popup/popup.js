const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

async function render() {
  const resp = await chrome.runtime.sendMessage({ cmd: "getAccount" }).catch(() => null);
  const a = (resp && resp.entitlement) || { signedIn: false };
  $("signedOut").classList.toggle("hidden", !!a.signedIn);
  $("signedIn").classList.toggle("hidden", !a.signedIn);
  $("signOut").classList.toggle("hidden", !a.signedIn);
  if (!a.signedIn) return;

  const usage = a.isPro
    ? "Unlimited removals"
    : `<b>${a.removalsRemaining ?? 0}</b> of ${a.removalsLimit ?? 40} free removals left this month`;
  $("acct").innerHTML =
    `<span class="plan${a.isPro ? " pro" : ""}">${a.isPro ? "Pro" : "Free"}</span>${esc(a.email)}<br>${usage}`;
  $("upgrade").classList.toggle("hidden", !!a.isPro);

  const { friends = {}, engagement = {} } = await chrome.storage.local.get(["friends", "engagement"]);
  const total = Object.keys(friends).length;
  const removed = Object.values(friends).filter((f) => f.removedAt).length;
  $("stat").innerHTML = total
    ? `<b>${total}</b> friends scanned · <b>${Object.keys(engagement).length}</b> events · <b>${removed}</b> removed`
    : "No scans yet — open the dashboard to start.";
}

$("signIn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ cmd: "signIn" });
  window.close();
});
$("open").addEventListener("click", () => {
  chrome.runtime.sendMessage({ cmd: "openDashboard" });
  window.close();
});
$("upgrade").addEventListener("click", () => {
  chrome.runtime.sendMessage({ cmd: "openBilling" });
  window.close();
});
$("help").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ cmd: "openSupport" });
  window.close();
});
$("signOut").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({ cmd: "signOut" });
  render();
});

render();
