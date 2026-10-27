class S {
    // ruleid: field-injection
    @Autowired
    private Repo repo;

    // ok: field-injection
    private final Repo other;

    // ok: field-injection
    @Autowired
    S(Repo other) { this.other = other; }
}
