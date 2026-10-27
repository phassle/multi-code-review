class Sec {
    void a(HttpSecurity http) throws Exception {
        // ruleid: permit-all-any-request
        http.authorizeHttpRequests(a -> a.anyRequest().permitAll());
        // ruleid: permit-all-any-request
        http.authorizeHttpRequests(a -> a.requestMatchers("/**").permitAll());
        // ok: permit-all-any-request
        http.authorizeHttpRequests(a -> a.requestMatchers("/public/**").permitAll().anyRequest().authenticated());
    }
}
