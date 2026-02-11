// Datasheet links sourced from:
// /Users/yohanaboujdid/Downloads/catalogue_produits_huawei_interactif copie.pdf
// and normalized with direct Huawei PDF URLs where available.
// For legacy smart power sensors without a public datasheet endpoint,
// we use the official Huawei quick guide/manual PDF.
const ORDERED_DATASHEET_URLS: string[] = [
  'https://solar.huawei.com/admin/asset/v1/pro/view/9005a18da2964ba2a0541ce4fbae4bef.pdf',
  'https://solar.huawei.com/-/media/Solar/attachment/pdf/la/datasheet/SUN2000-30-40KTL-M3.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/1e029d00296a4b87a9823fd083db547e.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/ada802421c674daa9047aeec9d28a710.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/ada802421c674daa9047aeec9d28a710.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/d44e17e9bfcf4481b361798f8039ab4d.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/d44e17e9bfcf4481b361798f8039ab4d.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/d44e17e9bfcf4481b361798f8039ab4d.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/d44e17e9bfcf4481b361798f8039ab4d.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/d44e17e9bfcf4481b361798f8039ab4d.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/c3ba89c365cb42ce92d9ba3c366253f1.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/c3ba89c365cb42ce92d9ba3c366253f1.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/c3ba89c365cb42ce92d9ba3c366253f1.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/c3ba89c365cb42ce92d9ba3c366253f1.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/c3ba89c365cb42ce92d9ba3c366253f1.pdf',
  'https://solar.huawei.com/download?p=%2F-%2Fmedia%2FSolarV4%2Fsolar-version2%2Feurope%2Fro%2Fprofessionals%2Fall-products%2Fproduct%2FLUNA2000-5-10-15-S0%2Fsupport%2FLUNA2000-5-10-15-S0-datasheet.pdf',
  'https://solar.huawei.com/download?p=%2F-%2Fmedia%2FSolarV4%2Fsolar-version2%2Feurope%2Fro%2Fprofessionals%2Fall-products%2Fproduct%2FLUNA2000-5-10-15-S0%2Fsupport%2FLUNA2000-5-10-15-S0-datasheet.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/422945b897cd4c1fb5ce16e2c7931240.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/37973b9d0ac64f8bbac4d5dce45cda84.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/95c57a958fd54fdda8a6fa0c7f71c8d4.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/a1adf14392d644c1b432f62ea10fa0ff.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/a1adf14392d644c1b432f62ea10fa0ff.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/79676c3a0de542bf8e6ff9da6d177138.pdf',
  'https://download.huawei.com/edownload/e/download.do?actionFlag=download&nid=EDOC1100020897&partNo=6001&mid=SUPE_DOC',
  'https://download.huawei.com/edownload/e/download.do?actionFlag=download&nid=EDOC1100020897&partNo=6001&mid=SUPE_DOC',
  'https://solar.huawei.com/admin/asset/v1/pro/view/7304f2b9c528458a98f242a8c4c3f672.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/7304f2b9c528458a98f242a8c4c3f672.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/38e8d9d6fdd44185abd71acfc620aa90.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/e3397de6d77c49ce903bea8a2dda7d06.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/fae1d0d46364459191f51ff78db88c3b.pdf',
  'https://solar.huawei.com/admin/asset/v1/pro/view/40f074ec410d44a6a23afb10d55b18a4.pdf',
];

const FALLBACK_RULES: Array<{ pattern: RegExp; url: string }> = [
  {
    pattern: /SUN2000-100KTL-M2/i,
    url: 'https://solar.huawei.com/admin/asset/v1/pro/view/9005a18da2964ba2a0541ce4fbae4bef.pdf',
  },
  {
    pattern: /SUN2000-(12|15|17|20|25)K-MB0/i,
    url: 'https://solar.huawei.com/admin/asset/v1/pro/view/c3ba89c365cb42ce92d9ba3c366253f1.pdf',
  },
  {
    pattern: /SUN2000-(5|6|8|10|12)K-MAP0/i,
    url: 'https://solar.huawei.com/admin/asset/v1/pro/view/d44e17e9bfcf4481b361798f8039ab4d.pdf',
  },
  {
    pattern: /SUN2000-30KTL-M3/i,
    url: 'https://solar.huawei.com/-/media/Solar/attachment/pdf/la/datasheet/SUN2000-30-40KTL-M3.pdf',
  },
  {
    pattern: /SUN2000-6KTL-L1/i,
    url: 'https://solar.huawei.com/admin/asset/v1/pro/view/1e029d00296a4b87a9823fd083db547e.pdf',
  },
  {
    pattern: /SUN2000-(8|10)K-LC0/i,
    url: 'https://solar.huawei.com/admin/asset/v1/pro/view/ada802421c674daa9047aeec9d28a710.pdf',
  },
];

export const getDatasheetUrl = (ref: string, order: number): string | null => {
  const fromOrder = ORDERED_DATASHEET_URLS[order - 1];
  if (fromOrder) {
    return fromOrder;
  }

  const fallback = FALLBACK_RULES.find((rule) => rule.pattern.test(ref));
  return fallback?.url ?? null;
};
