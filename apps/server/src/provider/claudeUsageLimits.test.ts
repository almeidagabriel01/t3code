import { describe, expect, it } from "vite-plus/test";

import {
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
  readableSubscriptionLimits,
} from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  const scopedLimit = (name: string | null) => ({
    kind: "weekly_scoped",
    scope: name === null ? null : { model: { id: null, display_name: name }, surface: null },
  });
  const sharesOf = (rateLimits: object) =>
    claudeUsageResponseToLimits({
      checkedAt,
      response: { rate_limits_available: true, rate_limits: rateLimits },
    }).limits.windows.filter((window) => window.id !== "seven_day");
  const fableScoped = { display_name: "Fable", utilization: 40, resets_at: null };
  const share = (limit_index: unknown, used: unknown, allowance: unknown = 50) => ({
    limit_index,
    used_percent_of_weekly: used,
    allowance_percent_of_weekly: allowance,
  });

  it.each([
    [
      "shares present",
      { limits: [{}, {}, scopedLimit("Fable")], weekly_scoped_shares: [share(2, 20)] },
      [{ weekUsedSharePercent: 20, weekAllowancePercent: 50 }],
    ],
    ["shares absent", { limits: [{}, {}, scopedLimit("Fable")] }, [{}]],
    [
      "limit_index out of range",
      { limits: [{}], weekly_scoped_shares: [share(2, 20), share(-1, 20), share(null, 20)] },
      [{}],
    ],
    [
      "limit that names no model",
      { limits: [scopedLimit(null)], weekly_scoped_shares: [share(0, 20)] },
      [{}],
    ],
    [
      "non-numeric used drops the share",
      { limits: [scopedLimit("Fable")], weekly_scoped_shares: [share(0, "20"), share(0, null)] },
      [{}],
    ],
    [
      "non-numeric allowance keeps the used share",
      { limits: [scopedLimit("Fable")], weekly_scoped_shares: [share(0, 20, "50")] },
      [{ weekUsedSharePercent: 20 }],
    ],
    [
      "values clamp to 0..100",
      { limits: [scopedLimit("Fable")], weekly_scoped_shares: [share(0, 140, -5)] },
      [{ weekUsedSharePercent: 100, weekAllowancePercent: 0 }],
    ],
    [
      "a malformed entry does not drop the others",
      {
        limits: [scopedLimit("Fable")],
        weekly_scoped_shares: [null, "x", share(0, 20, 50)],
      },
      [{ weekUsedSharePercent: 20, weekAllowancePercent: 50 }],
    ],
  ])("scoped shares: %s", (_name, extra, expected) => {
    const windows = sharesOf({ model_scoped: [fableScoped], ...extra });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ id: "seven_day_fable", usedPercent: 40, ...expected[0] });
    if (Object.keys(expected[0]!).length === 0) {
      expect(windows[0]).not.toHaveProperty("weekUsedSharePercent");
      expect(windows[0]).not.toHaveProperty("weekAllowancePercent");
    }
  });

  it("scoped shares: two scoped models each get their own share", () => {
    const windows = sharesOf({
      model_scoped: [fableScoped, { display_name: "Opus", utilization: 10, resets_at: null }],
      limits: [scopedLimit("Opus"), scopedLimit("Fable")],
      weekly_scoped_shares: [share(1, 20, 50), share(0, 5, 30)],
    });
    expect(windows.map((w) => [w.id, w.weekUsedSharePercent, w.weekAllowancePercent])).toEqual([
      ["seven_day_fable", 20, 50],
      ["seven_day_opus", 5, 30],
    ]);
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });

  const enterpriseResponse = {
    rate_limits_available: true,
    rate_limits: {
      five_hour: null,
      seven_day: null,
      spend: {
        enabled: true,
        used: { amount_minor: 4_631, currency: "USD", exponent: 2 },
        limit: { amount_minor: 50_000, currency: "USD", exponent: 2 },
        percent: 9,
      },
      extra_usage: {
        is_enabled: true,
        used_credits: 4_631,
        monthly_limit: 50_000,
        utilization: 9.261999999999999,
        currency: "USD",
        decimal_places: 2,
      },
    },
  };
  const monthlyWindow = {
    id: "monthly_spend",
    kind: "monthly",
    label: "Monthly spend",
    usedPercent: expect.closeTo(9.262, 10),
  };

  it("maps the captured Enterprise budget precisely, preferring spend beside rolling windows", () => {
    expect(claudeUsageResponseToLimits({ checkedAt, response: enterpriseResponse }).limits).toEqual(
      {
        checkedAt,
        windows: [monthlyWindow],
      },
    );
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...enterpriseResponse.rate_limits,
        five_hour: { utilization: 12, resets_at: null },
        extra_usage: {
          ...enterpriseResponse.rate_limits.extra_usage,
          used_credits: 30_000,
          utilization: 60,
        },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 12,
        windowDurationMins: 300,
      },
      monthlyWindow,
    ]);
  });

  it("falls back to enabled extra usage amounts or utilization when spend is unusable", () => {
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...enterpriseResponse.rate_limits,
        spend: {
          ...enterpriseResponse.rate_limits.spend,
          enabled: false,
          used: { amount_minor: 30_000, currency: "USD", exponent: 2 },
        },
        extra_usage: { ...enterpriseResponse.rate_limits.extra_usage, utilization: 9 },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([
      monthlyWindow,
    ]);
    const utilizationOnly = {
      ...response,
      rate_limits: {
        ...response.rate_limits,
        spend: { enabled: true, used: null, limit: null, percent: 9 },
        extra_usage: {
          ...enterpriseResponse.rate_limits.extra_usage,
          used_credits: null,
          monthly_limit: null,
        },
      },
    };
    expect(
      claudeUsageResponseToLimits({ checkedAt, response: utilizationOnly }).limits.windows,
    ).toEqual([monthlyWindow]);
  });

  it("omits disabled budgets and refuses invalid money without an enabled fallback", () => {
    const rateLimits = enterpriseResponse.rate_limits;
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...rateLimits,
        spend: { ...rateLimits.spend, enabled: false },
        extra_usage: { ...rateLimits.extra_usage, is_enabled: false },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
    response.rate_limits.spend = {
      ...rateLimits.spend,
      limit: { ...rateLimits.spend.limit, currency: "EUR" },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
    response.rate_limits.spend = {
      ...rateLimits.spend,
      limit: { ...rateLimits.spend.limit, amount_minor: 0 },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });
});

describe("readableSubscriptionLimits", () => {
  const unsupported = {
    checkedAt: "2026-10-28T00:00:00.000Z",
    windows: [],
    unavailable: { reason: "unsupported" as const },
  };

  it("treats a subscription account's unavailable limits as a failed read", () => {
    expect(readableSubscriptionLimits(unsupported, "max").unavailable?.reason).toBe("probeFailed");
  });

  it("keeps unsupported for accounts without a subscription", () => {
    expect(readableSubscriptionLimits(unsupported, undefined)).toBe(unsupported);
  });
});
