import type { Direction, Severity } from './types.ts';

/**
 * Every change contractwatch reports. A rule's severity can depend on direction: removing a property
 * breaks clients that read it (response) but not clients that send it (request).
 */
interface Rule {
  title: string;
  severity: Severity | Record<Direction, Severity>;
}

const both = (request: Severity, response: Severity) => ({ request, response });

export const RULES = {
  'spec-version-changed': { title: 'OpenAPI version changed', severity: 'info' },
  'base-path-changed': { title: 'Server base path changed', severity: 'breaking' },
  'server-removed': { title: 'Server URL removed', severity: 'warning' },
  'server-added': { title: 'Server URL added', severity: 'info' },

  'operation-removed': { title: 'Operation removed', severity: 'breaking' },
  'operation-added': { title: 'Operation added', severity: 'info' },
  'operation-deprecated': { title: 'Operation deprecated', severity: 'warning' },
  'operation-undeprecated': { title: 'Operation no longer deprecated', severity: 'info' },
  'security-added': { title: 'Operation now requires authentication', severity: 'breaking' },
  'security-changed': { title: 'Operation security requirements changed', severity: 'warning' },
  'security-removed': { title: 'Operation no longer requires authentication', severity: 'info' },

  'required-parameter-added': { title: 'Required parameter added', severity: 'breaking' },
  'parameter-added': { title: 'Optional parameter added', severity: 'info' },
  'parameter-removed': { title: 'Parameter removed', severity: 'warning' },
  'parameter-became-required': { title: 'Parameter became required', severity: 'breaking' },
  'parameter-became-optional': { title: 'Parameter became optional', severity: 'info' },
  'parameter-deprecated': { title: 'Parameter deprecated', severity: 'info' },
  'parameter-serialization-changed': { title: 'Parameter style or explode changed', severity: 'breaking' },

  'required-request-body-added': { title: 'Required request body added', severity: 'breaking' },
  'request-body-added': { title: 'Optional request body added', severity: 'info' },
  'request-body-removed': { title: 'Request body removed', severity: 'warning' },
  'request-body-became-required': { title: 'Request body became required', severity: 'breaking' },
  'request-body-became-optional': { title: 'Request body became optional', severity: 'info' },
  'request-media-type-removed': { title: 'Request media type removed', severity: 'breaking' },
  'request-media-type-added': { title: 'Request media type added', severity: 'info' },

  'success-response-removed': { title: 'Success response removed', severity: 'breaking' },
  'response-now-covered': { title: 'Response folded into a range or default', severity: 'info' },
  'error-response-removed': { title: 'Error response removed', severity: 'info' },
  'response-added': { title: 'Response added', severity: 'info' },
  'response-media-type-removed': { title: 'Response media type removed', severity: 'breaking' },
  'response-media-type-added': { title: 'Response media type added', severity: 'info' },
  'response-header-removed': { title: 'Response header removed', severity: 'warning' },
  'required-response-header-removed': { title: 'Required response header removed', severity: 'breaking' },
  'response-header-added': { title: 'Response header added', severity: 'info' },

  'type-changed': { title: 'Type changed', severity: 'breaking' },
  'type-widened': { title: 'Type widened', severity: both('info', 'breaking') },
  'type-narrowed': { title: 'Type narrowed', severity: both('breaking', 'info') },
  'became-nullable': { title: 'Became nullable', severity: both('info', 'breaking') },
  'no-longer-nullable': { title: 'No longer nullable', severity: both('breaking', 'info') },
  'property-removed': { title: 'Property removed', severity: both('warning', 'breaking') },
  'property-removed-closed': { title: 'Property removed from a closed object', severity: 'breaking' },
  'required-property-added': { title: 'Required property added', severity: both('breaking', 'info') },
  'property-added': { title: 'Property added', severity: 'info' },
  'property-became-required': { title: 'Property became required', severity: both('breaking', 'info') },
  'property-became-optional': { title: 'Property became optional', severity: both('info', 'breaking') },
  'enum-value-added': { title: 'Enum value added', severity: both('info', 'warning') },
  'enum-value-removed': { title: 'Enum value removed', severity: both('breaking', 'info') },
  'enum-added': { title: 'Values restricted to an enum', severity: both('breaking', 'info') },
  'enum-removed': { title: 'Enum restriction removed', severity: both('info', 'warning') },
  'format-changed': { title: 'Format changed', severity: 'warning' },
  'constraint-tightened': { title: 'Constraint tightened', severity: both('breaking', 'info') },
  'constraint-loosened': { title: 'Constraint loosened', severity: both('info', 'warning') },
  'pattern-changed': { title: 'Pattern changed', severity: both('warning', 'info') },
  'additional-properties-restricted': { title: 'Additional properties no longer allowed', severity: both('breaking', 'info') },
  'additional-properties-allowed': { title: 'Additional properties now allowed', severity: both('info', 'warning') },
  'variant-added': { title: 'oneOf/anyOf variant added', severity: both('info', 'warning') },
  'variant-removed': { title: 'oneOf/anyOf variant removed', severity: both('breaking', 'info') },
  'discriminator-property-changed': { title: 'Discriminator property changed', severity: 'breaking' },
  'discriminator-value-added': { title: 'Discriminator value added', severity: both('info', 'warning') },
  'discriminator-value-removed': { title: 'Discriminator value removed', severity: both('breaking', 'info') },

  // Callbacks and webhooks are requests the server sends to the client, so their directions are swapped.
  'callback-removed': { title: 'Callback removed', severity: 'warning' },
  'callback-added': { title: 'Callback added', severity: 'info' },
  'webhook-removed': { title: 'Webhook removed', severity: 'warning' },
  'webhook-added': { title: 'Webhook added', severity: 'info' },
  'callback-media-type-removed': { title: 'Callback or webhook media type removed', severity: 'breaking' },
} satisfies Record<string, Rule>;

export type RuleId = keyof typeof RULES;

export function severityOf(rule: RuleId, direction?: Direction): Severity {
  const s: Rule['severity'] = RULES[rule].severity;
  return typeof s === 'string' ? s : s[direction ?? 'response'];
}
