// ruleid: cors-any-origin
@CrossOrigin(origins = "*")
@RestController
class A {
    // ruleid: cors-any-origin
    @CrossOrigin("*")
    @GetMapping("/x")
    String x() { return ""; }

    // ok: cors-any-origin
    @CrossOrigin(origins = "https://app.example.com")
    @GetMapping("/y")
    String y() { return ""; }

    void z(CorsRegistry registry, CorsConfiguration config) {
        // ruleid: cors-any-origin
        registry.addMapping("/**").allowedOrigins("*");
        // ruleid: cors-any-origin
        config.addAllowedOrigin("*");
        // ok: cors-any-origin
        config.addAllowedOrigin("https://app.example.com");
    }
}
