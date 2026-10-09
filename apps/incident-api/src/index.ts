import { brokenQuote, healthyQuote } from './pricing.js';

type Variant = 'healthy' | 'broken';

export function handleQuoteRequest(request: Request, variant: Variant, release: string): Response {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json({ status: 'ok', release });
  }

  if (request.method !== 'GET' || url.pathname !== '/quote') {
    return Response.json({ error: 'Route not found', requestId }, { status: 404 });
  }

  const type = url.searchParams.get('type');
  const quantity = Number(url.searchParams.get('quantity'));
  if (
    (type !== 'standard' && type !== 'priority') ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 10
  ) {
    return Response.json(
      { error: 'Use type=standard|priority and quantity=1..10', requestId },
      { status: 400 },
    );
  }

  try {
    const total = variant === 'broken'
      ? brokenQuote(type, quantity)
      : healthyQuote(type, quantity);
    console.log({ event: 'quote.completed', requestId, release, type, quantity, total });
    return Response.json({ requestId, release, type, quantity, total });
  } catch (error) {
    console.error({
      event: 'quote.failed', requestId, release, type, quantity,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: 'Quote failed', requestId, release }, { status: 500 });
  }
}

export default {
  fetch(request, env) {
    if (env.INCIDENT_VARIANT !== 'healthy' && env.INCIDENT_VARIANT !== 'broken') {
      throw new Error('INCIDENT_VARIANT must be healthy or broken');
    }
    return handleQuoteRequest(request, env.INCIDENT_VARIANT, env.RELEASE_LABEL);
  },
} satisfies ExportedHandler<Env>;
