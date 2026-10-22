/** Build identity is injected by the image build and exposed through healthz. */
export function buildInfo() {
  return {
    version: process.env.ANYSENTRY_BUILD_VERSION || process.env.npm_package_version || 'dev',
    commit: process.env.ANYSENTRY_BUILD_COMMIT || 'unknown',
    builtAt: process.env.ANYSENTRY_BUILD_TIME || 'unknown',
    components: {
      api: process.env.ANYSENTRY_API_VERSION || process.env.ANYSENTRY_BUILD_VERSION || 'dev',
      observer: process.env.ANYSENTRY_OBSERVER_VERSION || 'unknown',
      flink: process.env.ANYSENTRY_FLINK_VERSION || 'unknown',
    },
  } as const;
}
