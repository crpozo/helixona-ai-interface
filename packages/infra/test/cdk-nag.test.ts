import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, HIPAASecurityChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { buildStacks } from '../lib/build-app.js';
import { loadConfig } from '../lib/config.js';

const env = { account: '123456789012', region: 'us-east-1' };

function synthWithNag(context: Record<string, unknown>) {
  const app = new cdk.App({ context: { stage: 'nag', ...context } });
  const stacks = buildStacks(app, loadConfig(app), env);
  cdk.Aspects.of(app).add(new AwsSolutionsChecks());
  cdk.Aspects.of(app).add(new HIPAASecurityChecks());
  app.synth();
  return stacks;
}

describe('cdk-nag (AwsSolutions + HIPAA Security)', () => {
  it('ningún stack tiene errores sin suprimir (configuración por defecto, sin certificado)', () => {
    const stacks = synthWithNag({});
    for (const stack of Object.values(stacks)) {
      const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('(AwsSolutions|HIPAA\\.Security)-.*'));
      expect(errors.map((e) => `${e.id}: ${JSON.stringify(e.entry.data)}`)).toEqual([]);
    }
  });

  it('ningún stack tiene errores sin suprimir (producción: certificado, dominio, email, CloudTrail)', () => {
    const stacks = synthWithNag({
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
      domainName: 'chat.clinica.example',
      appBaseUrl: 'https://chat.clinica.example',
      alertEmail: 'alertas@clinica.example',
      enableCloudTrail: true,
      enableNat: true,
      tlsToContainer: true,
      geoAllowCountries: 'US',
    });
    for (const stack of Object.values(stacks)) {
      const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('(AwsSolutions|HIPAA\\.Security)-.*'));
      expect(errors.map((e) => `${e.id}: ${JSON.stringify(e.entry.data)}`)).toEqual([]);
    }
  });
});
