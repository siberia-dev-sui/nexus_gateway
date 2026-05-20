const { query } = require('../db')

async function syncVendorCompanies(odooPost) {
  const tag = '[SYNC_VENDOR_COMPANIES]'
  let data
  try {
    data = await odooPost('/nexus/api/v1/all_vendor_companies', {})
  } catch (err) {
    console.error(`${tag} Error al llamar /all_vendor_companies:`, err.message)
    return { vendors: 0, companies: 0, errores: 1 }
  }

  const vendors = data?.vendors || []
  let companies = 0

  for (const vendor of vendors) {
    const vendorUuid = vendor.nexus_uuid
    const vendorCompanies = vendor.companies || []
    const companyIds = vendorCompanies.map((company) => Number(company.id)).filter(Boolean)

    for (const company of vendorCompanies) {
      await query(
        `INSERT INTO vendor_companies (
           vendor_uuid, company_id, company_name, currency_code,
           warehouse_id, warehouse_name, is_default, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (vendor_uuid, company_id) DO UPDATE SET
           company_name   = EXCLUDED.company_name,
           currency_code  = EXCLUDED.currency_code,
           warehouse_id   = EXCLUDED.warehouse_id,
           warehouse_name = EXCLUDED.warehouse_name,
           is_default     = EXCLUDED.is_default,
           updated_at     = NOW()`,
        [
          vendorUuid,
          company.id,
          company.name,
          company.currency || null,
          company.warehouse_id || null,
          company.warehouse_name || null,
          Number(company.id) === Number(vendor.default_company_id),
        ]
      )
      companies++
    }

    if (companyIds.length) {
      await query(
        'DELETE FROM vendor_companies WHERE vendor_uuid = $1 AND company_id != ALL($2::int[])',
        [vendorUuid, companyIds]
      )
    } else if (vendorUuid) {
      await query('DELETE FROM vendor_companies WHERE vendor_uuid = $1', [vendorUuid])
    }
  }

  console.log(`${tag} ${vendors.length} vendedor(es), ${companies} empresa(s) sincronizadas`)
  return { vendors: vendors.length, companies }
}

module.exports = { syncVendorCompanies }
