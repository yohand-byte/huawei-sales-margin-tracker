// ============================================================================
// DELUGE - Scheduler "Zoho -> Tracker" (4x / jour)
// Module: Zoho Books - Scheduled Custom Function
// ============================================================================
// 1) Remplace WEBHOOK_URL + WEBHOOK_TOKEN
// 2) Cree un scheduler: 00:05, 06:05, 12:05, 18:05
// 3) Cette fonction sync uniquement les commandes Huawei modifiees recemment.
// ============================================================================

WEBHOOK_URL = "https://lahtdxvbcscinoxyyjgw.supabase.co/functions/v1/zoho-invoice-webhook";
WEBHOOK_TOKEN = "REPLACE_WITH_YOUR_ZOHO_WEBHOOK_TOKEN";

LOOKBACK_DAYS = 3;
PER_PAGE = 200;
MAX_PAGES = 20;

org_id = "";
if (organization != null && organization.get("organization_id") != null)
{
	org_id = organization.get("organization_id").toString();
}
if (org_id == "")
{
	org_id = zoho.books.getOrganizations().get(0).get("organization_id").toString();
}

from_date = zoho.currentdate.subDay(LOOKBACK_DAYS).toString("yyyy-MM-dd");
synced_count = 0;
failed_count = 0;
skipped_non_huawei = 0;

for each page_idx in 1..MAX_PAGES
{
	params = Map();
	params.put("sort_column", "last_modified_time");
	params.put("sort_order", "D");
	params.put("per_page", PER_PAGE);
	params.put("page", page_idx);
	params.put("date_start", from_date);

	list_resp = zoho.books.getRecords("salesorders", org_id.toLong(), params);
	orders = list_resp.get("salesorders");
	if (orders == null || orders.isEmpty())
	{
		break;
	}

	for each so in orders
	{
		so_id = ifnull(so.get("salesorder_id"), "").toString();
		if (so_id == "")
		{
			failed_count = failed_count + 1;
			continue;
		}

		detail_resp = zoho.books.getRecordById("salesorders", org_id.toLong(), so_id);
		so_data = detail_resp.get("salesorder");
		if (so_data == null)
		{
			failed_count = failed_count + 1;
			continue;
		}

		// Filtre Huawei uniquement.
		is_huawei = false;
		line_items = so_data.get("line_items");
		if (line_items != null)
		{
			for each li in line_items
			{
				sku = ifnull(li.get("sku"), "").toString().toUpperCase();
				name = ifnull(li.get("name"), "").toString().toLowerCase();
				if
				(
					sku.startsWith("HUA/") ||
					sku.startsWith("HUAWEI") ||
					name.contains("sun2000") ||
					name.contains("sdongle") ||
					name.contains("smart dongle") ||
					name.contains("smartlogger") ||
					name.contains("luna2000") ||
					name.contains("emma")
				)
				{
					is_huawei = true;
					break;
				}
			}
		}

		if (!is_huawei)
		{
			skipped_non_huawei = skipped_non_huawei + 1;
			continue;
		}

		payload = Map();
		payload.put("salesorder", so_data);

		webhook_resp = invokeurl
		[
			url : WEBHOOK_URL + "?token=" + WEBHOOK_TOKEN
			type : POST
			parameters : payload
			headers : {"Content-Type":"application/json","x-zoho-webhook-token":WEBHOOK_TOKEN}
		];

		if (webhook_resp != null && webhook_resp.get("ok") == true)
		{
			synced_count = synced_count + 1;
		}
		else
		{
			failed_count = failed_count + 1;
		}
	}

	if (orders.size() < PER_PAGE)
	{
		break;
	}
}

result = Map();
result.put("status", true);
result.put("from_date", from_date);
result.put("synced_orders", synced_count);
result.put("failed_orders", failed_count);
result.put("skipped_non_huawei", skipped_non_huawei);
return result;
