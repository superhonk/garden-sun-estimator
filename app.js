const checkButton = document.querySelector("#check-device");
const checkSummary = document.querySelector("#check-summary");
const capabilityList = document.querySelector("#capability-list");

function getCapabilities() {
  return [
    {
      name: "Camera",
      supported: Boolean(navigator.mediaDevices?.getUserMedia),
    },
    {
      name: "Location",
      supported: "geolocation" in navigator,
    },
    {
      name: "Device orientation",
      supported: "DeviceOrientationEvent" in window,
    },
    {
      name: "Local assessment storage",
      supported: "indexedDB" in window,
    },
  ];
}

function renderCapabilityCheck() {
  const capabilities = getCapabilities();
  const supportedCount = capabilities.filter(({ supported }) => supported).length;

  capabilityList.replaceChildren(
    ...capabilities.map(({ name, supported }) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      const result = document.createElement("strong");

      label.textContent = name;
      result.textContent = supported ? "Available" : "Not detected";
      item.append(label, result);
      return item;
    }),
  );

  checkSummary.textContent =
    supportedCount === capabilities.length
      ? "This browser exposes all of the capabilities planned for measurement."
      : `${supportedCount} of ${capabilities.length} planned capabilities were detected.`;
  checkButton.textContent = "Check again";
}

checkButton?.addEventListener("click", renderCapabilityCheck);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // Offline support is an enhancement; the core page remains usable without it.
    });
  });
}
