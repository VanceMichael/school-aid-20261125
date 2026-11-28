// 采购结款方客户端：按 fixtures/partner.json 的协议提交付款、查询单项。
// 断线（accepted_disconnect）会以网络错误形式抛出，由业务层记为“资金未明”。
export function createPartnerClient(baseUrl, config) {
  const submit = async ({ key, items }) => {
    const response = await fetch(baseUrl + config.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [config.key]: key },
      body: JSON.stringify({ [config.group]: items }),
      signal: AbortSignal.timeout(3000)
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 409) {
      const error = new Error('结款方请求键冲突');
      error.code = 'PARTNER_CONFLICT';
      error.body = body;
      throw error;
    }
    return { status: response.status, results: body.results ?? [] };
  };

  const lookup = async (id) => {
    const response = await fetch(baseUrl + config.lookup + encodeURIComponent(id), {
      signal: AbortSignal.timeout(3000)
    });
    if (response.status === 404) return null;
    return response.json();
  };

  return { submit, lookup };
}
