const getApiUrl = () => {
  // Use VITE_API_URL in any environment when set (needed for cross-origin deployments)
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  if (import.meta.env.DEV) return "http://localhost:4000";
  return window.location.origin;
};

const api = (path, options = {}) => {
  const base = getApiUrl();
  const url = path.startsWith("http") ? path : `${base}${path}`;
  return fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
};

export { getApiUrl, api };
