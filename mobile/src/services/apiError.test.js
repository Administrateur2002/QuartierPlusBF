import { getApiErrorMessage } from "./apiError";

test("surfaces the actual API validation error", () => {
  const error = {
    isAxiosError: true,
    message: "Request failed with status code 400",
    response: { status: 400, data: { error: "Place déjà réservée." } },
  };
  expect(getApiErrorMessage(error, "Réservation impossible.")).toBe("Place déjà réservée.");
});

test("uses a useful status when the server response has no message", () => {
  const error = { isAxiosError: true, message: "Request failed", response: { status: 503, data: {} } };
  expect(getApiErrorMessage(error, "Voyage indisponible")).toBe("Voyage indisponible (HTTP 503).");
});

test("explains a network failure without pretending the server answered", () => {
  const error = { isAxiosError: true, message: "Network Error", code: "ERR_NETWORK" };
  expect(getApiErrorMessage(error, "Chargement impossible")).toBe("Chargement impossible Vérifiez la connexion réseau.");
});

test("preserves a non-HTTP error message", () => {
  expect(getApiErrorMessage(new Error("Permission refusée."), "Échec")).toBe("Permission refusée.");
});
