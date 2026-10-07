/**
 * A real SIP call routed by ViaRoute through the media server (FreeSWITCH + media agent), no mocks:
 *   fake trunk ─SIP─► media server ─Carrier API─► this API (campaign → buyer) ─► media server ─SIP─► trunk (buyer answers)
 * Runs only with SIP_E2E=1 and the media test stack up:
 *   docker compose -f infra/media/test/docker-compose.yml up -d --build
 *   SIP_E2E=1 pnpm --filter @viaroute/api test sip-media
 */
import type { INestApplication } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { prisma } from '@viaroute/db';
import { EslClient } from '../../media-agent/src/esl';
import { createApp, portal, resetDb, signupTenant, verifyEmail, waitFor } from './helpers';

const run = process.env.SIP_E2E ? describe : describe.skip;
const PORT = 4555;
const COMPOSE = resolve(__dirname, '../../../infra/media/test/docker-compose.yml');

run('SIP trunk call through the media server', () => {
  jest.setTimeout(180_000);
  let app: INestApplication;
  let admin: ReturnType<typeof portal>;
  let carrier: EslClient;

  beforeAll(async () => {
    await resetDb();
    app = await createApp();
    await app.listen(PORT, '0.0.0.0');
    await prisma.user.create({ data: { email: 'root@viaroute.test', name: 'Root', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash('RootPass123', 4) } });
    const res = await portal(app, null).post('/auth/login', { email: 'root@viaroute.test', password: 'RootPass123' }).expect(200);
    admin = portal(app, null, res.body.token);
    carrier = new EslClient({ host: '127.0.0.1', port: 18021, password: 'carrier', events: ['CHANNEL_ANSWER'] });
    carrier.start();
    await new Promise((r) => carrier.once('ready', r));
  });

  afterAll(async () => {
    carrier?.stop();
    // Put the agent back on its default (stand-alone test) settings.
    execSync(`docker compose -f "${COMPOSE}" up -d agent`, { stdio: 'ignore' });
    await app.close();
    await prisma.$disconnect();
  });

  it('routes a trunk call to the buyer over SIP, bills it and keeps the recording', async () => {
    // 1) The media server is a Custom API carrier in ViaRoute.
    const created = await admin
      .post('/admin/providers', {
        name: 'Verizon trunk (media server)',
        type: 'CUSTOM',
        credentials: { apiKey: 'test-agent-key', baseUrl: 'http://localhost:18088', numbersApi: false },
        inboundPerMinute: 0.004,
        outboundPerMinute: 0.006,
      })
      .expect(201);
    const providerId = created.body.id as string;
    execSync(`docker compose -f "${COMPOSE}" up -d agent`, {
      stdio: 'ignore',
      env: {
        ...process.env,
        VIAROUTE_WEBHOOK_URL: `http://host.docker.internal:${PORT}/webhooks/carrier/${providerId}`,
        VIAROUTE_WEBHOOK_SECRET: created.body.webhookSecret,
      },
    });
    const health = await waitFor(
      async () => (await admin.post(`/admin/providers/${providerId}/test`)).body as { ok?: boolean; message?: string },
      (b) => b.ok === true,
      30_000,
    );
    expect(health.message).toContain('trunk');

    // 2) A customer with a number on that trunk, a campaign and a buyer.
    const c = await signupTenant(app);
    await verifyEmail(app, c);
    const tenant = await prisma.tenant.update({ where: { subdomain: c.sub }, data: { walletBalance: 50, providerId } });
    const api = portal(app, c.sub, c.token);
    const number = await admin.post(`/admin/tenants/${tenant.id}/numbers`, { e164: '+14155550142', providerId, type: 'LOCAL', monthlyPrice: 2 }).expect(201);
    const camp = await api.post('/campaigns', { name: 'SIP campaign', revenue: 12, convertAfterSeconds: 3 }).expect(201);
    const buyer = await api.post('/buyers', { name: 'SIP buyer', destination: '+12125550199' }).expect(201);
    await api.post(`/campaigns/${camp.body.id}/routes`, { buyerId: buyer.body.id }).expect(201);
    await api.patch(`/numbers/${number.body.id}`, { campaignId: camp.body.id }).expect(200);

    // 3) The trunk delivers a call (10-digit caller ID, as many carriers send it).
    const leg = randomUUID();
    await carrier.bgapi(
      `originate {origination_uuid=${leg},origination_caller_id_number=3055550100}sofia/external/4155550142@172.29.0.10:5060 &endless_playback(tone_stream://%(1000,500,350))`,
      randomUUID(),
    );

    // 4) ViaRoute answers, plays the notice, rings the buyer through the trunk and connects them.
    const connected = await waitFor(
      () => prisma.call.findFirst({ where: { tenantId: tenant.id } }),
      (call) => !!call?.answeredAt,
      40_000,
    );
    expect(connected).toMatchObject({ callerNumber: '+13055550100', provider: 'custom', providerId, buyerId: buyer.body.id, campaignId: camp.body.id });

    // 5) Talk for a bit, then the caller hangs up.
    await new Promise((r) => setTimeout(r, 6000));
    await carrier.api(`uuid_kill ${leg}`);

    const done = await waitFor(
      () => prisma.call.findUniqueOrThrow({ where: { id: connected!.id } }),
      (call) => call.status === 'COMPLETED' && !!call.recordingUrl,
      40_000,
    );
    expect(done.converted).toBe(true);
    expect(done.connectedSec).toBeGreaterThanOrEqual(4);
    expect(Number(done.revenue)).toBe(12);
    expect(done.recordingSize).toBeGreaterThan(4000);
    expect(done.recordingUrl).toMatch(/\.mp3$/);
    expect(Number(done.carrierCost)).toBeGreaterThan(0);
    const after = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(Number(after.walletBalance)).toBeLessThan(50); // usage charged
  });
});
