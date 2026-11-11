import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/openai/errors.js';
import { attemptChain, createFallbackClient, fallbackModel, modelMissing, providerDown, providerList } from '../src/openai/fallback.js';
import { defaults } from '../src/core/config.js';

test('known models fall back to another channel', () => {
    assert.equal(fallbackModel('gpt-6.1-terra'), 'openai/gpt-6.1-terra');
    assert.equal(fallbackModel('openai/gpt-6.1-sol'), 'anthropic/claude-opus-5.5');
    assert.equal(fallbackModel('openai/gpt-6-luna-decisions'), 'typesafe/jev-1.14');
    assert.equal(modelMissing(new ApiError('missing', { status: 404, apiCode: 'model_not_found' })), true);
    assert.equal(modelMissing(new ApiError('bad temperature', { status: 400 })), false);
    assert.equal(providerDown(new ApiError('down', { code: 'TIMEOUT' })), true);
    assert.equal(providerDown(new ApiError('no', { status: 401 })), true);
    assert.equal(providerDown(new ApiError('bad', { status: 400 })), false);
});

test('a missing model is tried on the same host, then on the next host', async () => {
    const seen = [];
    const result = await attemptChain({
        endpoints: [{ label: 'primary' }, { label: 'https://sprutdock.ru/v1' }],
        model: 'gpt-6.1-terra',
        map: defaults.fallback.models,
        send: async (endpoint, model) => {
            seen.push(`${endpoint.label}:${model}`);
            if (model !== 'anthropic/claude-haiku-5-5' && model !== 'openai/gpt-6.1-terra' || endpoint.label === 'primary') {
                throw new ApiError('missing', { status: 404, apiCode: 'model_not_found' });
            }
            return { ok: true };
        },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [
        'primary:gpt-6.1-terra',
        'primary:openai/gpt-6.1-terra',
        'https://sprutdock.ru/v1:gpt-6.1-terra',
        'https://sprutdock.ru/v1:openai/gpt-6.1-terra'
    ]);
});

test('a persistent request error does not move to the next host', async () => {
    let calls = 0;
    await assert.rejects(() => attemptChain({
        endpoints: [{ label: 'primary' }, { label: 'other' }],
        model: 'gpt-6.1-terra',
        map: {},
        send: async () => {
            calls += 1;
            throw new ApiError('bad input', { status: 400 });
        },
    }), (error) => error.status === 400);
    assert.equal(calls, 1);
});

test('sprutdock is used only when its key is present', () => {
    const config = { baseURL: 'https://sprutdock.ru/v1', backends: defaults.fallback.providers };
    // The first backend (proxyapi) is the primary, so providerList returns the remaining 3
    assert.deepEqual(providerList(config, {}), [
        { baseURL: 'https://api.proxyapi.ru/v1', apiKey: "{{env:PROXYAPI_API_KEY}}" },
        { baseURL: 'https://routerai.ru/api/v1', apiKey: "{{env:ROUTERAI_API_KEY}}" },
        // `useWalletBalance` is a request-body parameter of the gateway, not a header.
        { baseURL: 'https://gptunnel.ru/v1', apiKey: '{{env:GPTUNNEL_API_KEY}}', body: { useWalletBalance: false } }
    ]);
    // A literal `{{env:...}}` value in the env map is passed through untouched, not expanded.
    assert.equal(providerList(config, { PROXYAPI_API_KEY: '{{env:PROXYAPI_API_KEY}}' })[0].baseURL, 'https://api.proxyapi.ru/v1');

    // unsupported or bad configured...
    //assert.equal(providerList(config, { ROUTERAI_API_KEY: '{{env:ROUTERAI_API_KEY}}' })[0].apiKey, '{{env:ROUTERAI_API_KEY}}');
});

/** A client factory that records hosts instead of opening sockets. */
function fakeTransport() {
    const opened = [];
    return {
        opened,
        create: (spec) => {
            opened.push(spec.baseURL);
            return { baseURL: spec.baseURL, call: async () => ({}), images: {}, responses: {}, close() {} };
        },
    };
}

test('the channel list hands a model to the host the config placed it on', () => {
    // The shape of a real config: several images hosts, and seedream-5.5 written down for one of
    // them only. Decomposition cannot go through images.generate, so it walks this list instead —
    // asking the primary host for seedream is what used to answer "Model 'seedream-5-5' not found".
    const { opened, create } = fakeTransport();
    const client = createFallbackClient({
        baseURL: 'https://sprutdock.ru/v1',
        apiKey: 'primary-key',
        imagesBackends: [
            { baseURL: 'https://sprutdock.ru/v1', apiKey: 'a' },
            { baseURL: 'https://api.apimart.ai/v1', apiKey: 'b' },
        ],
        modelsBackends: {
            'seedream-5-5': [{ baseURL: 'https://api.apimart.ai/v1', apiKey: 'b', vendor: 'bytedance-seed' }],
        },
    }, { create });
    const narrow = client.channels('images', 'seedream-5-5');
    assert.deepEqual(narrow.map((channel) => channel.label), ['https://api.apimart.ai/v1']);
    assert.equal(typeof narrow[0].client.call, 'function', 'a channel carries the client that must be called');
    assert.equal(narrow[0].modelFor('seedream-5-5'), 'bytedance-seed/seedream-5-5', 'the host names the model its own way');
    // A model the map does not place still walks the whole pool, so nothing is lost for it.
    assert.deepEqual(client.channels('images', 'gpt-image-2.6-sunburst').map((channel) => channel.label),
        ['https://sprutdock.ru/v1', 'https://api.apimart.ai/v1']);
    client.close();
    assert.ok(opened.length > 0, 'the hosts were opened through the injected factory');
});
