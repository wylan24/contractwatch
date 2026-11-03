import { RULES } from './rules.ts';

/**
 * JSON Schema for `.contractwatch.json`, for editor completion and checks. Generated from the rule list so
 * the two can't drift; `npm run schema` writes it to `schema/contractwatch.schema.json`.
 */
export function configSchema(): object {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://raw.githubusercontent.com/wylan24/contractwatch/main/schema/contractwatch.schema.json',
    title: 'contractwatch configuration',
    type: 'object',
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      rules: {
        description: "Change a rule's severity, or turn it off.",
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(RULES).map(([id, r]) => [id, { description: r.title, enum: ['breaking', 'warning', 'info', 'off'] }]),
        ),
      },
      ignore: {
        description: 'Operations to skip: `/path/*` matches one segment, `/path/**` any depth, optionally prefixed by a method.',
        type: 'array',
        items: { type: 'string', examples: ['/internal/**', 'DELETE /admin/*'] },
      },
      accept: {
        description: "Breaking changes made on purpose. They are still reported, with the reason, but don't fail the check.",
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'reason'],
          properties: {
            id: { description: 'Change id, as shown in the report.', type: 'string', pattern: '^[0-9a-f]{8}$' },
            reason: { description: 'Why this break is intended. Shown in the report.', type: 'string', minLength: 1 },
            expires: { description: 'After this date (YYYY-MM-DD) the acceptance no longer applies.', type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
      },
      allowBreakingOnMajorBump: {
        description: 'Breaking changes pass when info.version gets a new major version (or a new minor version in 0.x).',
        type: 'boolean',
      },
    },
  };
}
