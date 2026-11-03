/**
 * Every environment variable the SDKs Pi 1.4.0 reaches its providers through
 * read (`@aws-sdk/*`, `@smithy/*`, `@aws/*`, `@anthropic-ai/sdk`, `openai`,
 * `@google/genai`, `google-auth-library`, `gcp-metadata`, `gaxios`), and Pi's
 * own `pi-ai`, each with what Switch decided of it:
 *
 * - `pi`: credentials, an endpoint or a region, so in Pi's `inheritEnv`
 *   (`PI_INHERIT_ENV`), which reaches Pi's sessions only;
 * - `shared`: every provider's sessions have it already (`EXECUTION_INHERIT_ENV`);
 * - `excluded`: kept from Pi, for the reason given.
 *
 * Found by searching those packages' JavaScript (not `dist-es`, types or maps)
 * for `process.env.X`, `process.env['X']`, `env['X']`, `env.X`, `readEnv('X')`,
 * `getEnv('X')`, `getProviderEnvValue('X')` and any quoted name with a
 * provider's prefix (`AWS_`, `ANTHROPIC_`, `OPENAI_`, `GOOGLE_`, `GCLOUD_`,
 * `GEMINI_`, `CLOUDSDK_`, `GCE_`, `METADATA_`, `AZURE_`, `CLOUDFLARE_`,
 * `KIMI_`). `at` is where in Pi's `node_modules` the search first found it. A
 * provider key Pi only looks up by its provider (`PI_PROVIDER_ENV`) is not
 * repeated here.
 */
export type PiSdkEnvDecision = 'pi' | 'shared' | { excluded: string };

/**
 * The Pi release whose SDKs were searched. A test fails while it is not
 * `PI_VERSION`, so a new release's variables are searched for and decided on
 * before Switch runs it.
 */
export const PI_SDK_ENV_REVIEWED_FOR = '1.4.0';

const ENUM = 'not a variable: a value of an enum, or a binding, that the search matched';
const CHAIN_OFF =
  "read by the Anthropic SDK's own credential chain, which Pi turns off (PiAnthropic); Pi builds federation from the variables it reads itself";
const WORKER = "read by the Anthropic SDK's environments worker, which Pi does not use";
const DEBUG = 'SDK logging or warnings, not credentials, an endpoint or a region';
const TUNING = 'retry, timeout or clock tuning, not credentials, an endpoint or a region';
const HOST_AWS = "set by AWS's own runtimes to describe the host, not by an operator";
const HOST_GCP = "set by Google's runtimes to describe the host, not by an operator";
const WRITTEN = 'written by google-auth-library for the executable it runs, not read';
const HEADERS =
  'free-form headers the SDK adds to every request of every Pi provider it serves, so a header meant for one endpoint would reach the others';

export const PI_SDK_ENV: Readonly<Record<string, { decision: PiSdkEnvDecision; at: string }>> = {
  AI: {
    decision: { excluded: ENUM },
    at: '@earendil-works/pi-ai/dist/api/cloudflare-ai-binding.js:10',
  },
  ANTHROPIC_API_KEY: { decision: 'pi', at: '@anthropic-ai/sdk/client.js:58' },
  ANTHROPIC_AUTH_TOKEN: { decision: 'pi', at: '@anthropic-ai/sdk/client.js:59' },
  ANTHROPIC_BASE_URL: { decision: 'shared', at: '@anthropic-ai/sdk/client.js:61' },
  ANTHROPIC_CONFIG_DIR: {
    decision: { excluded: CHAIN_OFF },
    at: '@anthropic-ai/sdk/core/credentials.js:262',
  },
  ANTHROPIC_CUSTOM_HEADERS: {
    decision: { excluded: HEADERS },
    at: '@anthropic-ai/sdk/client.js:116',
  },
  ANTHROPIC_ENVIRONMENT_ID: {
    decision: { excluded: WORKER },
    at: '@anthropic-ai/sdk/lib/environments/worker.js:179',
  },
  ANTHROPIC_ENVIRONMENT_KEY: {
    decision: { excluded: WORKER },
    at: '@anthropic-ai/sdk/lib/environments/worker.js:182',
  },
  ANTHROPIC_FEDERATION_RULE_ID: { decision: 'pi', at: '@anthropic-ai/sdk/core/credentials.js:78' },
  ANTHROPIC_IDENTITY_TOKEN: {
    decision: { excluded: CHAIN_OFF },
    at: '@anthropic-ai/sdk/lib/credentials/credential-chain.js:161',
  },
  ANTHROPIC_IDENTITY_TOKEN_FILE: { decision: 'pi', at: '@anthropic-ai/sdk/core/credentials.js:79' },
  ANTHROPIC_LOG: { decision: { excluded: DEBUG }, at: '@anthropic-ai/sdk/client.js:109' },
  ANTHROPIC_OAUTH_TOKEN: { decision: 'pi', at: '@earendil-works/pi-ai/dist/env-api-keys.js:31' },
  ANTHROPIC_ORGANIZATION_ID: { decision: 'pi', at: '@anthropic-ai/sdk/core/credentials.js:75' },
  ANTHROPIC_PROFILE: {
    decision: { excluded: CHAIN_OFF },
    at: '@anthropic-ai/sdk/core/credentials.js:66',
  },
  ANTHROPIC_SCOPE: {
    decision: { excluded: CHAIN_OFF },
    at: '@anthropic-ai/sdk/core/credentials.js:77',
  },
  ANTHROPIC_SERVICE_ACCOUNT_ID: { decision: 'pi', at: '@anthropic-ai/sdk/core/credentials.js:80' },
  ANTHROPIC_SESSION_ID: {
    decision: { excluded: WORKER },
    at: '@anthropic-ai/sdk/lib/environments/worker.js:179',
  },
  ANTHROPIC_WEBHOOK_SIGNING_KEY: {
    decision: { excluded: 'a webhook signing secret, never used to call a model' },
    at: '@anthropic-ai/sdk/client.js:60',
  },
  ANTHROPIC_WORKSPACE_ID: { decision: 'pi', at: '@anthropic-ai/sdk/core/credentials.js:76' },
  ANTHROPIC_WORK_ID: {
    decision: { excluded: WORKER },
    at: '@anthropic-ai/sdk/lib/environments/worker.js:178',
  },
  ANTHROPIC_WORK_SECRET: {
    decision: { excluded: WORKER },
    at: '@anthropic-ai/sdk/lib/environments/worker.js:194',
  },
  APPDATA: { decision: 'shared', at: '@anthropic-ai/sdk/core/credentials.mjs:228' },
  AWS_ACCESS_KEY: {
    decision: { excluded: ENUM },
    at: '@aws-sdk/client-bedrock-runtime/dist-cjs/index.js:2354',
  },
  AWS_ACCESS_KEY_ID: { decision: 'pi', at: '@aws-sdk/credential-provider-env/dist-cjs/index.js:4' },
  AWS_ACCOUNT_ID: { decision: 'pi', at: '@aws-sdk/credential-provider-env/dist-cjs/index.js:9' },
  AWS_ACCOUNT_ID_ENDPOINT_MODE: {
    decision: { excluded: 'read only by clients with account endpoints; Bedrock Runtime has none' },
    at: '@aws-sdk/core/dist-cjs/submodules/account-id-endpoint/index.js:27',
  },
  AWS_AUTH_SCHEME_PREFERENCE: {
    decision: 'pi',
    at: '@aws-sdk/core/dist-cjs/submodules/httpAuthSchemes/index.js:151',
  },
  AWS_BEARER_TOKEN_BEDROCK: { decision: 'pi', at: 'openai/bedrock.js:59' },
  AWS_BEDROCK_BASE_URL: {
    decision: { excluded: "read by the OpenAI SDK's Bedrock client, which Pi does not use" },
    at: 'openai/bedrock.js:19',
  },
  AWS_BEDROCK_FORCE_CACHE: {
    decision: { excluded: "Pi's prompt caching switch, not credentials, an endpoint or a region" },
    at: '@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js:689',
  },
  AWS_BEDROCK_FORCE_HTTP1: {
    decision: { excluded: "Pi's HTTP version switch, not credentials, an endpoint or a region" },
    at: '@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js:113',
  },
  AWS_BEDROCK_SKIP_AUTH: {
    decision: 'pi',
    at: '@earendil-works/pi-ai/dist/api/bedrock-converse-stream.js:68',
  },
  AWS_CONFIG_FILE: { decision: 'pi', at: '@smithy/core/dist-cjs/submodules/config/index.js:212' },
  AWS_CONTAINER_AUTHORIZATION_TOKEN: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-http/dist-cjs/index.js:112',
  },
  AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-http/dist-cjs/index.js:111',
  },
  AWS_CONTAINER_CREDENTIALS_FULL_URI: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-http/dist-cjs/index.js:110',
  },
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-http/dist-cjs/index.js:108',
  },
  AWS_CREDENTIAL_EXPIRATION: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-env/dist-cjs/index.js:7',
  },
  AWS_CREDENTIAL_SCOPE: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-env/dist-cjs/index.js:8',
  },
  AWS_DEFAULTS_MODE: {
    decision: { excluded: TUNING },
    at: '@smithy/core/dist-cjs/submodules/config/index.js:694',
  },
  AWS_DEFAULT_REGION: {
    decision: 'pi',
    at: '@smithy/core/dist-cjs/submodules/config/index.js:483',
  },
  AWS_DISABLE_CLOCK_SKEW_CORRECTION: {
    decision: { excluded: TUNING },
    at: '@aws-sdk/core/dist-cjs/submodules/httpAuthSchemes/index.js:336',
  },
  AWS_EC2_METADATA_DISABLED: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-node/dist-cjs/index.js:4',
  },
  AWS_EC2_METADATA_SERVICE_ENDPOINT: {
    decision: 'pi',
    at: '@smithy/core/dist-cjs/submodules/config/index.js:532',
  },
  AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: {
    decision: 'pi',
    at: '@smithy/core/dist-cjs/submodules/config/index.js:540',
  },
  AWS_EC2_METADATA_V1_DISABLED: {
    decision: 'pi',
    at: '@smithy/credential-provider-imds/dist-cjs/index.js:236',
  },
  AWS_ENDPOINT_URL: { decision: 'pi', at: '@smithy/core/dist-cjs/submodules/endpoints/index.js:8' },
  AWS_EXECUTION_ENV: {
    decision: { excluded: HOST_AWS },
    at: '@aws-sdk/core/dist-cjs/submodules/client/index.js:776',
  },
  AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: {
    decision: 'pi',
    at: '@smithy/core/dist-cjs/submodules/endpoints/index.js:45',
  },
  AWS_LAMBDA_BENCHMARK_MODE: {
    decision: { excluded: HOST_AWS },
    at: '@aws/lambda-invoke-store/dist-cjs/invoke-store.js:118',
  },
  AWS_LAMBDA_FUNCTION_NAME: {
    decision: { excluded: HOST_AWS },
    at: '@aws-sdk/core/dist-cjs/submodules/client/index.js:176',
  },
  AWS_LAMBDA_MAX_CONCURRENCY: {
    decision: { excluded: HOST_AWS },
    at: '@aws/lambda-invoke-store/dist-cjs/invoke-store.js:99',
  },
  AWS_LOGIN_CACHE_DIRECTORY: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-login/dist-cjs/index.js:179',
  },
  AWS_MAX_ATTEMPTS: {
    decision: { excluded: TUNING },
    at: '@smithy/core/dist-cjs/submodules/retry/index.js:733',
  },
  AWS_PROFILE: { decision: 'pi', at: '@smithy/core/dist-cjs/submodules/config/index.js:173' },
  AWS_REGION: { decision: 'pi', at: '@aws-sdk/credential-provider-login/dist-cjs/index.js:66' },
  AWS_RETRY_MODE: {
    decision: { excluded: TUNING },
    at: '@smithy/core/dist-cjs/submodules/retry/index.js:786',
  },
  AWS_ROLE_ARN: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-web-identity/dist-cjs/index.js:32',
  },
  AWS_ROLE_SESSION_NAME: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-web-identity/dist-cjs/index.js:33',
  },
  AWS_SDK_JS_NODE_VERSION_SUPPORT_WARNING_DISABLED: {
    decision: { excluded: DEBUG },
    at: '@aws-sdk/core/dist-cjs/submodules/client/index.js:25',
  },
  AWS_SDK_UA_APP_ID: {
    decision: { excluded: 'an application id for the user agent: telemetry' },
    at: '@aws-sdk/core/dist-cjs/submodules/client/index.js:786',
  },
  AWS_SECRET_ACCESS_KEY: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-env/dist-cjs/index.js:5',
  },
  AWS_SECRET_KEY: {
    decision: { excluded: ENUM },
    at: '@aws-sdk/client-bedrock-runtime/dist-cjs/index.js:2355',
  },
  AWS_SESSION_TOKEN: { decision: 'pi', at: '@aws-sdk/credential-provider-env/dist-cjs/index.js:6' },
  AWS_SHARED_CREDENTIALS_FILE: {
    decision: 'pi',
    at: '@smithy/core/dist-cjs/submodules/config/index.js:215',
  },
  AWS_SIGV4A_SIGNING_REGION_SET: {
    decision: 'pi',
    at: '@aws-sdk/core/dist-cjs/submodules/httpAuthSchemes/index.js:181',
  },
  AWS_USE_DUALSTACK_ENDPOINT: {
    decision: 'pi',
    at: '@smithy/core/dist-cjs/submodules/config/index.js:414',
  },
  AWS_USE_FIPS_ENDPOINT: {
    decision: 'pi',
    at: '@smithy/core/dist-cjs/submodules/config/index.js:428',
  },
  AWS_WEB_IDENTITY_TOKEN_FILE: {
    decision: 'pi',
    at: '@aws-sdk/credential-provider-web-identity/dist-cjs/index.js:31',
  },
  AZURE_OPENAI_API_KEY: { decision: 'pi', at: 'openai/azure.js:18' },
  AZURE_OPENAI_API_VERSION: {
    decision: 'pi',
    at: '@earendil-works/pi-ai/dist/api/azure-openai-config.js:72',
  },
  AZURE_OPENAI_BASE_URL: {
    decision: 'pi',
    at: '@earendil-works/pi-ai/dist/api/azure-openai-config.js:54',
  },
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP: {
    decision: 'pi',
    at: '@earendil-works/pi-ai/dist/api/azure-openai-config.js:22',
  },
  AZURE_OPENAI_ENDPOINT: {
    decision: { excluded: 'read by AzureOpenAI only without a base URL, which Pi always gives it' },
    at: 'openai/azure.js:17',
  },
  AZURE_OPENAI_RESOURCE_NAME: {
    decision: 'pi',
    at: '@earendil-works/pi-ai/dist/api/azure-openai-config.js:55',
  },
  CLOUDFLARE_ACCOUNT_ID: {
    decision: 'pi',
    at: '@earendil-works/pi-ai/dist/providers/cloudflare-auth.js:2',
  },
  CLOUDFLARE_API_KEY: { decision: 'pi', at: '@earendil-works/pi-ai/dist/env-api-keys.js:110' },
  CLOUDFLARE_GATEWAY_ID: {
    decision: 'pi',
    at: '@earendil-works/pi-ai/dist/providers/cloudflare-auth.js:3',
  },
  CLOUDSDK_CONFIG: {
    decision: 'shared',
    at: 'google-auth-library/build/src/auth/googleauth.js:338',
  },
  CLOUD_RUN_JOB: {
    decision: { excluded: HOST_GCP },
    at: 'google-auth-library/build/src/auth/envDetect.js:83',
  },
  DEBUG_AUTH: { decision: { excluded: DEBUG }, at: 'gcp-metadata/build/src/index.js:323' },
  DETECT_GCP_RETRIES: { decision: { excluded: TUNING }, at: 'gcp-metadata/build/src/index.js:281' },
  FUNCTION_NAME: {
    decision: { excluded: HOST_GCP },
    at: 'google-auth-library/build/src/auth/envDetect.js:72',
  },
  FUNCTION_TARGET: {
    decision: { excluded: HOST_GCP },
    at: 'google-auth-library/build/src/auth/envDetect.js:72',
  },
  GAE_MODULE_NAME: {
    decision: { excluded: HOST_GCP },
    at: 'google-auth-library/build/src/auth/envDetect.js:69',
  },
  GAE_SERVICE: {
    decision: { excluded: HOST_GCP },
    at: 'google-auth-library/build/src/auth/envDetect.js:69',
  },
  GCE_METADATA_HOST: { decision: 'pi', at: 'gcp-metadata/build/src/index.js:96' },
  GCE_METADATA_IP: { decision: 'pi', at: 'gcp-metadata/build/src/index.js:95' },
  GCLOUD_PROJECT: { decision: 'pi', at: 'google-auth-library/build/src/auth/googleauth.js:636' },
  GEMINI_API_KEY: { decision: 'pi', at: '@google/genai/dist/index.cjs:27' },
  GOOGLE_API_CERTIFICATE_CONFIG: {
    decision: 'pi',
    at: 'google-auth-library/build/src/auth/certificatesubjecttokensupplier.js:21',
  },
  GOOGLE_API_KEY: { decision: 'shared', at: '@google/genai/dist/node/index.cjs:26350' },
  GOOGLE_APPLICATION_CREDENTIALS: {
    decision: 'pi',
    at: 'google-auth-library/build/src/auth/googleauth.js:316',
  },
  GOOGLE_CLOUD_API_KEY: { decision: 'pi', at: '@earendil-works/pi-ai/dist/env-api-keys.js:87' },
  GOOGLE_CLOUD_LOCATION: { decision: 'pi', at: '@google/genai/dist/node/index.cjs:26253' },
  GOOGLE_CLOUD_PROJECT: { decision: 'pi', at: '@google/genai/dist/node/index.cjs:26252' },
  GOOGLE_CLOUD_QUOTA_PROJECT: {
    decision: 'pi',
    at: 'google-auth-library/build/src/auth/googleauth.js:287',
  },
  GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: {
    decision: 'pi',
    at: 'google-auth-library/build/src/auth/pluggable-auth-client.js:38',
  },
  GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE: {
    decision: { excluded: WRITTEN },
    at: 'google-auth-library/build/src/auth/pluggable-auth-client.js:184',
  },
  GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL: {
    decision: { excluded: WRITTEN },
    at: 'google-auth-library/build/src/auth/pluggable-auth-client.js:193',
  },
  GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE: {
    decision: { excluded: WRITTEN },
    at: 'google-auth-library/build/src/auth/pluggable-auth-client.js:187',
  },
  GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE: {
    decision: { excluded: WRITTEN },
    at: 'google-auth-library/build/src/auth/pluggable-auth-client.js:189',
  },
  GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE: {
    decision: { excluded: WRITTEN },
    at: 'google-auth-library/build/src/auth/pluggable-auth-client.js:185',
  },
  GOOGLE_GEMINI_BASE_URL: { decision: 'shared', at: '@google/genai/dist/node/index.cjs:26300' },
  GOOGLE_GENAI_USE_ENTERPRISE: {
    decision: {
      excluded:
        "would move Pi's Gemini API client, which does not say which service it is for, to another service",
    },
    at: '@google/genai/dist/node/index.cjs:26136',
  },
  GOOGLE_GENAI_USE_VERTEXAI: {
    decision: {
      excluded:
        "would move Pi's Gemini API client, which does not say which service it is for, to Vertex",
    },
    at: '@google/genai/dist/node/index.cjs:26137',
  },
  GOOGLE_MAPS: { decision: { excluded: ENUM }, at: '@google/genai/dist/index.cjs:1831' },
  GOOGLE_SEARCH_IMAGE: { decision: { excluded: ENUM }, at: '@google/genai/dist/index.cjs:1823' },
  GOOGLE_SEARCH_WEB: { decision: { excluded: ENUM }, at: '@google/genai/dist/index.cjs:1819' },
  GOOGLE_SERVICE_ACCOUNT_AUTH: {
    decision: { excluded: ENUM },
    at: '@google/genai/dist/index.cjs:668',
  },
  GOOGLE_VERTEX_BASE_URL: { decision: 'shared', at: '@google/genai/dist/node/index.cjs:26300' },
  HOME: { decision: 'shared', at: '@anthropic-ai/sdk/core/credentials.mjs:244' },
  KIMI_API_KEY: { decision: 'pi', at: '@earendil-works/pi-ai/dist/env-api-keys.js:108' },
  KIMI_CODE_OAUTH_HOST: {
    decision: 'pi',
    at: '@earendil-works/pi-ai/dist/auth/oauth/kimi-coding.js:18',
  },
  KIMI_OAUTH_HOST: {
    decision: 'pi',
    at: '@earendil-works/pi-ai/dist/auth/oauth/kimi-coding.js:18',
  },
  K_CONFIGURATION: {
    decision: { excluded: HOST_GCP },
    at: 'google-auth-library/build/src/auth/envDetect.js:80',
  },
  K_SERVICE: { decision: { excluded: HOST_GCP }, at: 'gcp-metadata/build/src/gcp-residency.js:57' },
  METADATA_SERVER_DETECTION: { decision: 'pi', at: 'gcp-metadata/build/src/index.js:78' },
  NO_PROXY: { decision: 'shared', at: 'gaxios/build/cjs/src/gaxios.js:222' },
  OPENAI_ADMIN_KEY: {
    decision: { excluded: 'an admin secret, never used to call a model' },
    at: 'openai/client.js:89',
  },
  OPENAI_API_KEY: { decision: 'pi', at: 'openai/client.js:88' },
  OPENAI_API_VERSION: {
    decision: {
      excluded: 'read by AzureOpenAI only without an API version, which Pi always gives it',
    },
    at: 'openai/azure.js:16',
  },
  OPENAI_BASE_URL: { decision: 'shared', at: 'openai/azure.js:21' },
  OPENAI_CUSTOM_HEADERS: { decision: { excluded: HEADERS }, at: 'openai/client.js:245' },
  OPENAI_LOG: { decision: { excluded: DEBUG }, at: 'openai/client.js:239' },
  OPENAI_ORG_ID: {
    decision: {
      excluded:
        'sent as a header to every endpoint Pi reaches with the OpenAI SDK (OpenRouter, Groq and others), not only OpenAI',
    },
    at: 'openai/azure.js:20',
  },
  OPENAI_PROJECT_ID: {
    decision: {
      excluded:
        'sent as a header to every endpoint Pi reaches with the OpenAI SDK (OpenRouter, Groq and others), not only OpenAI',
    },
    at: 'openai/client.js:91',
  },
  OPENAI_WEBHOOK_SECRET: {
    decision: { excluded: 'a webhook signing secret, never used to call a model' },
    at: 'openai/client.js:92',
  },
  PATH: { decision: 'shared', at: '@anthropic-ai/sdk/tools/agent-toolset/node.js:901' },
  PI_CACHE_RETENTION: {
    decision: { excluded: "Pi's prompt caching setting, not credentials, an endpoint or a region" },
    at: '@earendil-works/pi-ai/dist/api/anthropic-messages.js:26',
  },
  PI_OAUTH_CALLBACK_HOST: {
    decision: { excluded: "where /login's browser returns to, used only while signing in" },
    at: '@earendil-works/pi-ai/dist/auth/oauth/anthropic.js:14',
  },
  USERPROFILE: { decision: 'shared', at: '@anthropic-ai/sdk/core/credentials.mjs:232' },
  XDG_CONFIG_HOME: {
    decision: { excluded: CHAIN_OFF },
    at: '@anthropic-ai/sdk/core/credentials.mjs:240',
  },
  // Named at run time: AWS_ENDPOINT_URL_ and a client’s service id.
  AWS_ENDPOINT_URL_BEDROCK_RUNTIME: {
    decision: 'pi',
    at: '@aws-sdk/client-bedrock-runtime/dist-cjs/index.js:2044',
  },
  AWS_ENDPOINT_URL_STS: {
    decision: 'pi',
    at: '@aws-sdk/nested-clients/dist-cjs/submodules/sts/index.js:576',
  },
  AWS_ENDPOINT_URL_SSO: {
    decision: 'pi',
    at: '@aws-sdk/nested-clients/dist-cjs/submodules/sso/index.js:321',
  },
  AWS_ENDPOINT_URL_SSO_OIDC: {
    decision: 'pi',
    at: '@aws-sdk/nested-clients/dist-cjs/submodules/sso-oidc/index.js:509',
  },
  AWS_ENDPOINT_URL_SIGNIN: {
    decision: 'pi',
    at: '@aws-sdk/nested-clients/dist-cjs/submodules/signin/index.js:415',
  },
  AWS_ENDPOINT_URL_COGNITO_IDENTITY: {
    decision: { excluded: 'the Cognito client, which no credential provider Pi uses runs' },
    at: '@aws-sdk/nested-clients/dist-cjs/submodules/cognito-identity/index.js:456',
  },
};
