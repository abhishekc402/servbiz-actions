package com.servbiz.appshell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host allow-listing is the control that stops a generated app from turning into
 * a general-purpose browser, and stops a lookalike domain from being treated as
 * the customer's own site. These cases exist because the obvious implementations
 * (`contains`, bare `endsWith`) pass the happy path and fail the attacks.
 *
 * Only [UrlRules.isAllowedHost] is covered here: it takes a plain String, so it
 * runs as a fast JVM test. [UrlRules.classify] needs android.net.Uri and would
 * require Robolectric or an instrumented test.
 */
class UrlRulesTest {

    private fun config(
        hosts: List<String>,
        allowSubdomains: Boolean = true
    ) = AppConfig.FALLBACK.copy(
        buildTime = AppConfig.BuildTime(
            startUrl = "https://${hosts.firstOrNull() ?: "example.com"}/",
            allowedHosts = hosts,
            allowSubdomains = allowSubdomains
        )
    )

    @Test
    fun `exact host is allowed`() {
        val c = config(listOf("acme.com"))
        assertTrue(UrlRules.isAllowedHost("acme.com", c))
    }

    @Test
    fun `host matching is case insensitive`() {
        val c = config(listOf("acme.com"))
        assertTrue(UrlRules.isAllowedHost("ACME.com", c))
        assertTrue(UrlRules.isAllowedHost("AcMe.CoM", c))
    }

    @Test
    fun `trailing dot is tolerated`() {
        val c = config(listOf("acme.com"))
        assertTrue(UrlRules.isAllowedHost("acme.com.", c))
    }

    @Test
    fun `subdomains allowed when enabled`() {
        val c = config(listOf("acme.com"))
        assertTrue(UrlRules.isAllowedHost("www.acme.com", c))
        assertTrue(UrlRules.isAllowedHost("shop.eu.acme.com", c))
    }

    @Test
    fun `subdomains rejected when disabled`() {
        val c = config(listOf("acme.com"), allowSubdomains = false)
        assertFalse(UrlRules.isAllowedHost("www.acme.com", c))
        assertTrue(UrlRules.isAllowedHost("acme.com", c))
    }

    @Test
    fun `suffix lookalike is rejected`() {
        // The bug a bare endsWith() check would ship.
        val c = config(listOf("acme.com"))
        assertFalse(UrlRules.isAllowedHost("notacme.com", c))
        assertFalse(UrlRules.isAllowedHost("evilacme.com", c))
    }

    @Test
    fun `prefix lookalike is rejected`() {
        // The bug a contains() check would ship: attacker owns the real domain.
        val c = config(listOf("acme.com"))
        assertFalse(UrlRules.isAllowedHost("acme.com.attacker.net", c))
        assertFalse(UrlRules.isAllowedHost("acme.com.evil", c))
    }

    @Test
    fun `unrelated host is rejected`() {
        val c = config(listOf("acme.com"))
        assertFalse(UrlRules.isAllowedHost("example.org", c))
        assertFalse(UrlRules.isAllowedHost("", c))
    }

    @Test
    fun `empty allow list rejects everything`() {
        // effectiveAllowedHosts falls back to the start URL host, but an app with
        // no resolvable host at all must not become open to the whole web.
        val c = AppConfig.FALLBACK.copy(
            buildTime = AppConfig.BuildTime("about:blank", emptyList(), true)
        )
        assertFalse(UrlRules.isAllowedHost("anything.com", c))
    }

    @Test
    fun `multiple hosts are all honoured`() {
        val c = config(listOf("acme.com", "acme-cdn.net"))
        assertTrue(UrlRules.isAllowedHost("acme.com", c))
        assertTrue(UrlRules.isAllowedHost("assets.acme-cdn.net", c))
        assertFalse(UrlRules.isAllowedHost("acme-cdn.com", c))
    }
}
