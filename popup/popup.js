chrome.storage.local.get(["friends", "engagement"]).then(({ friends = {}, engagement = {} }) => {
  const total = Object.keys(friends).length;
  const removed = Object.values(friends).filter((f) => f.removedAt).length;
  document.getElementById("stat").innerHTML =
    total
      ? `<b>${total}</b> friends scanned · <b>${Object.keys(engagement).length}</b> events · <b>${removed}</b> removed`
      : "No scans yet — open the dashboard to start.";
});

document.getElementById("open").addEventListener("click", () => {
  chrome.runtime.sendMessage({ cmd: "openDashboard" });
  window.close();
});
