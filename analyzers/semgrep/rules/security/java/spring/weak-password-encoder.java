class Enc {
    PasswordEncoder a() {
        // ruleid: weak-password-encoder
        return NoOpPasswordEncoder.getInstance();
    }
    PasswordEncoder b() {
        // ruleid: weak-password-encoder
        return new MessageDigestPasswordEncoder("SHA-256");
    }
    PasswordEncoder c() {
        // ok: weak-password-encoder
        return new BCryptPasswordEncoder();
    }
}
