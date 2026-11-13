// Runs before the page paints: applies dark only when the visitor chose it with the "Dark theme" button.
// The OS preference is deliberately ignored (light is the default for everyone).
try {
  if (localStorage.getItem("flightseal-theme") === "dark") document.documentElement.setAttribute("data-theme", "dark");
} catch {
  // storage blocked: stay light
}
