import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;

class Sec {
    void a(HttpSecurity http) throws Exception {
        // ruleid: csrf-disabled
        http.csrf(c -> c.disable());
        // ruleid: csrf-disabled
        http.csrf(AbstractHttpConfigurer::disable).cors(c -> {});
        // ruleid: csrf-disabled
        http.csrf().disable();
        // ok: csrf-disabled
        http.csrf(c -> c.ignoringRequestMatchers("/webhook"));
    }
}
