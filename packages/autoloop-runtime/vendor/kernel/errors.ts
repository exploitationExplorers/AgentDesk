// What a door answers when it says no. Each maps to one HTTP status in http.ts.
export class InputError extends Error {}
export class AuthError extends Error {}
export class Conflict extends Error {}
export class NotFound extends Error {}
