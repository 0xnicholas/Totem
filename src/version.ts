/**
 * The totem release version — the single constant every surface that
 * reports a version reads from (the MCP server info and the OpenAPI
 * document's `info.version`, T24). Mirrors the `version` field in
 * package.json; bump both together on release.
 */
export const TOTEM_VERSION = '0.1.0';
