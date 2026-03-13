import { defineConfigSchema, z } from "jsr:@pons/sdk@^0.2/config";

const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  url: z.string().optional(),
  token: z.string().optional(),
}).passthrough();

const authProfileSchema = z.object({
  id: z.string(),
  credential: z.string(),
  type: z.enum(["api_key", "oauth"]).default("api_key"),
});

const routingRuleSchema = z.object({
  provider: z.string(),
  model: z.string(),
});

const routingSchema = z.object({
  classifierProvider: z.string().optional(),
  classifierModel: z.string().optional(),
  rules: z.record(routingRuleSchema).optional(),
  toolOverrides: z.record(routingRuleSchema).optional(),
});

const planningSchema = z.object({
  provider: z.string(),
  model: z.string(),
});

export default defineConfigSchema(
  z.object({
    providers: z.record(providerConfigSchema).default({}),
    authProfiles: z.record(z.array(authProfileSchema)).optional(),
    routing: routingSchema.optional(),
    planning: planningSchema.optional(),
  }),
  {
    description: "LLM providers, auth profiles, model routing, and planning configuration",
    labels: {
      providers: "LLM Providers",
      authProfiles: "Auth Profiles",
      routing: "Model Routing",
      planning: "Planning Model",
    },
  }
);
