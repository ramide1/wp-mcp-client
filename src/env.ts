/**
 * Helpers to read the configuration from the environment.
 *
 * Every timeout of the project is configured in **seconds** (see
 * `.env.example`) and converted to milliseconds here. Centralizing the
 * conversion avoids the classic bug of reading a value documented in seconds
 * as if it were milliseconds.
 */

/**
 * Read a timeout from the environment and convert it to milliseconds.
 *
 * @param name Name of the environment variable
 * @param fallbackSeconds Value used when the variable is missing or invalid
 */
export const timeoutFromEnv = (name: string, fallbackSeconds: number): number =>
    secondsFromEnv(name, fallbackSeconds) * 1000;

/**
 * Read a number of seconds from the environment.
 *
 * @param name Name of the environment variable
 * @param fallbackSeconds Value used when the variable is missing or invalid
 */
export const secondsFromEnv = (name: string, fallbackSeconds: number): number => {
    const parsed = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSeconds;
};

/**
 * Read a positive integer from the environment.
 *
 * @param name Name of the environment variable
 * @param fallback Value used when the variable is missing or invalid
 */
export const intFromEnv = (name: string, fallback: number): number => {
    const parsed = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
