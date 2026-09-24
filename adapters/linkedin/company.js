import { defineAdapter, errors } from 'opencli-mcp/adapter-sdk';
import { compact, ensureLinkedIn, linkedinApi, requireElements } from './_shared.js';

export function companySlug(value) {
  const raw = compact(value);
  if (!raw) throw errors.argument('company is required');
  let slug = raw;
  if (raw.startsWith('/') || /^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw, 'https://www.linkedin.com'); }
    catch { throw errors.argument('company must be a LinkedIn company name or URL'); }
    if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname)
      || url.username || url.password || url.port) throw errors.argument('company URL must be on linkedin.com');
    slug = url.pathname.match(/^\/company\/([^/]+)(?:\/.*)?$/)?.[1] || '';
    try { slug = decodeURIComponent(slug); }
    catch { throw errors.argument('company URL has an invalid slug'); }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) throw errors.argument('company name has invalid characters');
  return slug;
}

export function mapCompany(company, slug) {
  if (!company?.entityUrn || !compact(company.name)) throw errors.upstream('LinkedIn company API returned a malformed company');
  const address = company.headquarter?.address || {};
  const headquarters = [address.city, address.geographicArea, address.country].map(compact).filter(Boolean).join(', ');
  const range = company.employeeCountRange || {};
  const size = range.start == null ? null : range.end == null ? `${range.start}+` : `${range.start}-${range.end}`;
  return {
    name: compact(company.name), industry: null, industry_urns: company.industryUrns || [],
    size, employee_count: Number.isInteger(company.employeeCount) ? company.employeeCount : null,
    headquarters: headquarters || null, founded: company.foundedOn?.year || null,
    website: compact(company.websiteUrl) || null, specialties: Array.isArray(company.specialities) ? company.specialities : [],
    followers: null, about: compact(company.description) || null,
    url: `https://www.linkedin.com/company/${encodeURIComponent(company.universalName || slug)}/about/`,
  };
}

export default defineAdapter({
  description: 'Read a LinkedIn company through the Voyager company API.',
  access: 'read', domain: 'linkedin.com',
  result: { kind: 'rows', description: 'Company details' },
  args: [{ name: 'company', type: 'string', required: true, help: 'Company name, /company/name path, or LinkedIn company URL' }],
  async run({ tab, args }) {
    const slug = companySlug(args.company);
    await ensureLinkedIn(tab);
    const path = `/voyager/api/voyagerOrganizationDashCompanies?q=universalName&universalName=${encodeURIComponent(slug)}`;
    const elements = requireElements(await linkedinApi(tab, path), 'LinkedIn company');
    if (!elements.length) throw errors.empty(`No LinkedIn company found for ${slug}`);
    return { rows: [mapCompany(elements[0], slug)] };
  },
});
