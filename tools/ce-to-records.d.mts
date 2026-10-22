export interface ConvertedRecord {
  date: string;
  provider: "aws";
  account: string;
  service: string;
  region?: string;
  usageType?: string;
  resource?: string;
  amount: number;
  currency: string;
  tags: Record<string, string>;
}
export function convert(ce: unknown, options?: { metric?: string; account?: string }): ConvertedRecord[];
