/** The Gor wordmark and purple star share one transparent header asset. */
export default function GorBrandLogo() {
  return (
    <span className="gor-brand-mark">
      <img className="gor-brand-logo" src={`${import.meta.env.BASE_URL}images/gor-header-logo.png?v=7`} alt="Gor" />
    </span>
  );
}
