import org.springframework.expression.ExpressionParser;
import org.springframework.expression.spel.standard.SpelExpressionParser;
import org.springframework.web.bind.annotation.*;

@RestController
class Calc {
    private final ExpressionParser parser = new SpelExpressionParser();

    @GetMapping("/a")
    Object a(@RequestParam String expr) {
        // ruleid: spel-injection
        return new SpelExpressionParser().parseExpression(expr).getValue();
    }

    @GetMapping("/b/{e}")
    Object b(@PathVariable("e") String e) {
        String full = "1 + " + e;
        // ruleid: spel-injection
        return parser.parseExpression(full).getValue();
    }

    @GetMapping("/c")
    Object c(@RequestParam String name) {
        // ok: spel-injection
        return parser.parseExpression("'hello'").getValue();
    }
}
