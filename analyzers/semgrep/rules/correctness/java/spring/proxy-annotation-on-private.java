class S {
    // ruleid: proxy-annotation-on-private
    @Transactional
    private void a() { }

    // ruleid: proxy-annotation-on-private
    @PreAuthorize("hasRole('ADMIN')")
    private void b() { }

    // ok: proxy-annotation-on-private
    @Transactional
    public void c() { }

    // ok: proxy-annotation-on-private
    @Deprecated
    private void d() { }
}
